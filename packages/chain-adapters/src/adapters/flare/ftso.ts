import { keccak256 } from "../../../../../lib/x402/evm.js";

/**
 * FTSO — the Flare Time Series Oracle. Flare's enshrined, decentralized price
 * oracle (block-latency feeds secured by ~100 independent providers). Cred402
 * uses it as the CANONICAL collateral-pricing oracle for the Flare satellite:
 * when an agent draws credit denominated in FXRP, the vault values the draw in
 * USD from the live FTSO XRP/USD feed — no third-party price API, no mock.
 *
 * Real path (default when `FLARE_RPC_URL` is set): read `FtsoV2.getFeedById`
 * over JSON-RPC `eth_call`. FtsoV2 is resolved from the well-known
 * FlareContractRegistry (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`, identical
 * on Flare / Songbird / Coston / Coston2) unless `FLARE_FTSOV2_ADDRESS` pins it.
 *
 * Sim path (no RPC): deterministic reference prices so the demo + test suite run
 * with zero keys and zero network. The shape returned is identical either way.
 *
 * Docs: https://dev.flare.network/ftso/overview
 */

/** Well-known FlareContractRegistry — same address on every Flare-family chain. */
const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

/** Deterministic reference prices (USD) for the sim path — stable, not random. */
const SIM_PRICES: Record<string, number> = {
  "FLR/USD": 0.02,
  "SGB/USD": 0.008,
  "XRP/USD": 0.52,
  "BTC/USD": 64000,
  "ETH/USD": 3200,
  "USDC/USD": 1.0,
  "USDT/USD": 1.0,
};

export interface FtsoPrice {
  feed: string; // "XRP/USD"
  feed_id: string; // 21-byte hex feed id
  value: number; // price in USD (already scaled by decimals)
  decimals: number;
  timestamp: number; // unix seconds
  source: "ftso" | "sim";
  /** True when a LIVE read was configured but had to fall back to the reference price
   * (RPC error / non-positive oracle value). Consumers should treat the value as
   * unreliable and fail closed (e.g. value collateral at zero borrowing power). */
  stale: boolean;
}

/**
 * Encode an FTSO feed id: category byte (0x01 = crypto) + ASCII of the feed name,
 * right-padded to 21 bytes total. e.g. "XRP/USD" → 0x015852502f555344…00 (21 bytes).
 */
export function feedIdFor(feed: string): string {
  const ascii = new TextEncoder().encode(feed);
  if (ascii.length > 20) throw new Error(`ftso: feed name too long: ${feed}`);
  const body = new Uint8Array(21);
  body[0] = 0x01; // crypto category
  body.set(ascii, 1);
  return "0x" + Buffer.from(body).toString("hex");
}

function selector(sig: string): string {
  return keccak256(sig).slice(0, 10);
}

/** ABI-encode a single `string` argument (offset + length + right-padded data). */
function encodeString(s: string): string {
  const data = Buffer.from(s, "utf8");
  const len = data.length.toString(16).padStart(64, "0");
  const padded = Buffer.concat([data, Buffer.alloc((32 - (data.length % 32)) % 32)]).toString("hex");
  const offset = (32).toString(16).padStart(64, "0");
  return offset + len + padded;
}

/** ABI-encode a `bytes21` argument (left-aligned / right-padded to 32 bytes). */
function encodeBytes21(hex: string): string {
  return hex.replace(/^0x/, "").padEnd(64, "0");
}

export class FtsoPriceClient {
  private readonly rpcUrl?: string;
  private readonly ftsoV2Override?: string;
  private ftsoV2Cache?: string;
  private readonly cacheTtlMs: number;
  private readonly priceCache = new Map<string, { price: FtsoPrice; at: number }>();

  constructor(opts: { rpcUrl?: string; ftsoV2Address?: string; cacheTtlMs?: number } = {}) {
    this.rpcUrl = opts.rpcUrl ?? process.env.FLARE_RPC_URL;
    this.ftsoV2Override = opts.ftsoV2Address ?? process.env.FLARE_FTSOV2_ADDRESS;
    // Short price cache so a fleet sweep (N agents, same feed) issues ONE RPC, not N.
    this.cacheTtlMs = opts.cacheTtlMs ?? Number(process.env.FLARE_FTSO_CACHE_MS ?? 1500);
  }

  /** True when a real FTSO read is configured (RPC endpoint present). */
  isLive(): boolean {
    return Boolean(this.rpcUrl);
  }

  private async ethCall(to: string, data: string): Promise<string> {
    if (!this.rpcUrl) throw new Error("ftso: no FLARE_RPC_URL configured");
    const res = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to, data }, "latest"],
      }),
    });
    const json = (await res.json()) as { result?: string; error?: { message: string } };
    if (json.error) throw new Error(`ftso: eth_call failed: ${json.error.message}`);
    if (!json.result) throw new Error("ftso: eth_call returned no result");
    return json.result;
  }

  /** Resolve FtsoV2 via the registry (cached), or the pinned override. */
  private async ftsoV2Address(): Promise<string> {
    if (this.ftsoV2Override) return this.ftsoV2Override;
    if (this.ftsoV2Cache) return this.ftsoV2Cache;
    const data = selector("getContractAddressByName(string)") + encodeString("FtsoV2");
    const raw = await this.ethCall(FLARE_CONTRACT_REGISTRY, data);
    const addr = "0x" + raw.replace(/^0x/, "").slice(24, 64); // last 20 bytes of the word
    this.ftsoV2Cache = addr;
    return addr;
  }

  /** Live FTSO read for one feed (cached briefly). Falls back to sim if RPC is not
   * configured, on any transient error, or if the oracle returns a non-positive value. */
  async getPrice(feed: string): Promise<FtsoPrice> {
    const cached = this.priceCache.get(feed);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) return cached.price;
    const price = await this.fetchPrice(feed);
    this.priceCache.set(feed, { price, at: Date.now() });
    return price;
  }

  private async fetchPrice(feed: string): Promise<FtsoPrice> {
    const feed_id = feedIdFor(feed);
    // No RPC configured → the reference price IS the intended value (not stale).
    if (!this.isLive()) return this.simPrice(feed, feed_id, false);
    try {
      const ftsoV2 = await this.ftsoV2Address();
      const data = selector("getFeedById(bytes21)") + encodeBytes21(feed_id);
      const raw = (await this.ethCall(ftsoV2, data)).replace(/^0x/, "");
      // returns (uint256 value, int8 decimals, uint64 timestamp) — three static words.
      const value = BigInt("0x" + raw.slice(0, 64));
      const decimals = Number(BigInt("0x" + raw.slice(64, 128)) & 0xffn);
      const timestamp = Number(BigInt("0x" + raw.slice(128, 192)));
      const priceNum = Number(value) / 10 ** decimals;
      // A zero/negative oracle value is invalid (uninitialized feed / bad word). In
      // LIVE mode, degrade to the reference price but mark it STALE so underwriting
      // fails closed instead of trusting a substituted price.
      if (!(priceNum > 0)) return this.simPrice(feed, feed_id, true);
      return { feed, feed_id, value: priceNum, decimals, timestamp, source: "ftso", stale: false };
    } catch {
      // A transient RPC failure must not read as a real price — degrade + mark stale.
      return this.simPrice(feed, feed_id, true);
    }
  }

  private simPrice(feed: string, feed_id: string, stale = false): FtsoPrice {
    const value = SIM_PRICES[feed];
    if (value === undefined) throw new Error(`ftso: no sim price for ${feed}`);
    return { feed, feed_id, value, decimals: 7, timestamp: 0, source: "sim", stale };
  }
}
