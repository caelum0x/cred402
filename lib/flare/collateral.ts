import { FtsoPriceClient } from "../../packages/chain-adapters/src/index.js";

/**
 * FTSO-priced multi-asset collateral.
 *
 * An agent's Flare credit line starts from its reputation (a USD cap). This vault lets
 * it post COLLATERAL in several assets — FLR, XRP, BTC, ETH, USDC — to expand its
 * borrowing power. Every asset is marked to its live FTSO feed and discounted by a
 * per-asset LTV haircut (volatile assets advance less), so the extra borrowing power
 * is `Σ collateral_usd × ltv`. This is Flare's multi-feed FTSO oracle doing exactly
 * what it is for: pricing a basket of heterogeneous assets on-chain with no third
 * party, turning agent credit into a real over-collateralized primitive.
 *
 * Deposits are held per agent, in each asset's smallest units. Valuation is live
 * (FTSO) with the deterministic sim reference as a fallback — identical shape either
 * way, so the demo + tests run with no keys.
 */

export interface CollateralAsset {
  symbol: string;
  ftso_feed: string;
  decimals: number;
  /** Loan-to-value / advance rate in basis points (e.g. 6000 = 60%). */
  ltv_bps: number;
}

/** Supported collateral assets and their FTSO feeds + LTV haircuts. */
export const COLLATERAL_ASSETS: Record<string, CollateralAsset> = {
  USDC: { symbol: "USDC", ftso_feed: "USDC/USD", decimals: 6, ltv_bps: 9500 },
  BTC: { symbol: "BTC", ftso_feed: "BTC/USD", decimals: 8, ltv_bps: 8000 },
  ETH: { symbol: "ETH", ftso_feed: "ETH/USD", decimals: 18, ltv_bps: 7500 },
  XRP: { symbol: "XRP", ftso_feed: "XRP/USD", decimals: 6, ltv_bps: 6000 },
  FLR: { symbol: "FLR", ftso_feed: "FLR/USD", decimals: 18, ltv_bps: 4000 },
};

export interface CollateralLine {
  symbol: string;
  amount: string; // smallest units
  amount_whole: number;
  price_usd: number;
  price_source: string;
  value_usd: number; // amount × price
  ltv_bps: number;
  borrowing_power_usd: number; // value_usd × ltv (0 when the price is stale)
  /** True when the FTSO price for this asset is a stale live fallback — contributes 0 power. */
  stale: boolean;
}

export interface CollateralValuation {
  agent_id: string;
  total_value_usd: number; // gross USD value of all collateral
  borrowing_power_usd: number; // Σ value × ltv (what the credit line can use)
  lines: CollateralLine[];
}

export class CollateralVault {
  // agent_id -> (symbol -> amount in smallest units)
  private readonly deposits = new Map<string, Map<string, bigint>>();

  constructor(private readonly ftso: FtsoPriceClient = new FtsoPriceClient()) {}

  static isSupported(symbol: string): boolean {
    return symbol.toUpperCase() in COLLATERAL_ASSETS;
  }

  private asset(symbol: string): CollateralAsset {
    const a = COLLATERAL_ASSETS[symbol.toUpperCase()];
    if (!a) throw new Error(`unsupported collateral asset: ${symbol} (supported: ${Object.keys(COLLATERAL_ASSETS).join(", ")})`);
    return a;
  }

  /** Deposit whole units of an asset as collateral. Returns the new balance (whole). */
  deposit(agentId: string, symbol: string, amountWhole: number): { symbol: string; balance_whole: number } {
    const asset = this.asset(symbol);
    if (!(amountWhole > 0) || !Number.isFinite(amountWhole)) throw new Error("deposit amount must be a positive finite number");
    const smallest = BigInt(Math.round(amountWhole * 10 ** asset.decimals));
    if (smallest <= 0n) throw new Error(`deposit amount too small: rounds to zero ${asset.symbol} units`);
    const byAsset = this.deposits.get(agentId) ?? new Map<string, bigint>();
    byAsset.set(asset.symbol, (byAsset.get(asset.symbol) ?? 0n) + smallest);
    this.deposits.set(agentId, byAsset);
    return { symbol: asset.symbol, balance_whole: this.balanceWhole(agentId, asset.symbol) };
  }

  /** Withdraw whole units; reverts if the balance is insufficient. */
  withdraw(agentId: string, symbol: string, amountWhole: number): { symbol: string; balance_whole: number } {
    const asset = this.asset(symbol);
    if (!(amountWhole > 0) || !Number.isFinite(amountWhole)) throw new Error("withdraw amount must be a positive finite number");
    const smallest = BigInt(Math.round(amountWhole * 10 ** asset.decimals));
    if (smallest <= 0n) throw new Error(`withdraw amount too small: rounds to zero ${asset.symbol} units`);
    const byAsset = this.deposits.get(agentId);
    const have = byAsset?.get(asset.symbol) ?? 0n;
    if (smallest > have) throw new Error(`insufficient ${asset.symbol} collateral: have ${this.balanceWhole(agentId, asset.symbol)}`);
    byAsset!.set(asset.symbol, have - smallest);
    return { symbol: asset.symbol, balance_whole: this.balanceWhole(agentId, asset.symbol) };
  }

  private balanceWhole(agentId: string, symbol: string): number {
    const asset = this.asset(symbol);
    const smallest = this.deposits.get(agentId)?.get(asset.symbol) ?? 0n;
    return Number(smallest) / 10 ** asset.decimals;
  }

  /** Value an agent's collateral basket in USD via FTSO, with LTV haircuts applied. */
  async valueUsd(agentId: string): Promise<CollateralValuation> {
    const byAsset = this.deposits.get(agentId);
    const lines: CollateralLine[] = [];
    let totalValue = 0;
    let borrowingPower = 0;
    for (const [symbol, smallest] of byAsset?.entries() ?? []) {
      if (smallest <= 0n) continue;
      const asset = this.asset(symbol);
      const price = await this.ftso.getPrice(asset.ftso_feed);
      const amountWhole = Number(smallest) / 10 ** asset.decimals;
      const valueUsd = amountWhole * price.value;
      // Fail closed: a stale live price (RPC outage / bad oracle word) contributes ZERO
      // borrowing power so an unpriceable asset can never inflate a credit line.
      const power = price.stale ? 0 : (valueUsd * asset.ltv_bps) / 10000;
      totalValue += valueUsd;
      borrowingPower += power;
      lines.push({
        symbol: asset.symbol,
        amount: smallest.toString(),
        amount_whole: amountWhole,
        price_usd: price.value,
        price_source: price.source,
        value_usd: round2(valueUsd),
        ltv_bps: asset.ltv_bps,
        borrowing_power_usd: round2(power),
        stale: price.stale,
      });
    }
    return {
      agent_id: agentId,
      total_value_usd: round2(totalValue),
      borrowing_power_usd: round2(borrowingPower),
      lines: lines.sort((a, b) => b.value_usd - a.value_usd),
    };
  }

  /** Just the LTV-weighted borrowing power (USD) — what PositionEngine adds to the cap. */
  async borrowingPowerUsd(agentId: string): Promise<number> {
    return (await this.valueUsd(agentId)).borrowing_power_usd;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
