/**
 * Cred402 Bitcoin adapter — Payment Reference Parser.
 *
 * "Casper-rooted, chain-executed." Bitcoin is treated as a PAYMENT / EVIDENCE
 * reference, never as a credit-execution chain. This module parses a Bitcoin
 * payment reference (a BIP21 URI, a raw txid, or a txid:vout outpoint) into a
 * normalized descriptor and derives a `payment_proof_hash` that is compatible with
 * the Universal Receipt Envelope (URE) defined in crosschain/standards/receipts.ts.
 *
 * The URE field `payment_proof_hash` is a `0x`-prefixed 32-byte hex digest. For a
 * Bitcoin payment, the canonical proof is the transaction that paid the seller. We
 * commit to it deterministically as:
 *
 *     payment_proof_hash = "0x" + sha256( canonical_json(BtcPaymentProof) )
 *
 * where BtcPaymentProof captures the txid, output index, paid address, amount in
 * satoshis, and a confirmations snapshot. This is reproducible by any party that
 * observes the same on-chain payment, so it is a sound payment proof commitment.
 *
 * Self-contained: only node builtins (`node:crypto`).
 */

import { createHash } from "node:crypto";

/** A 64-hex-character Bitcoin transaction id. */
export type Txid = string;

/** Parsed, normalized Bitcoin payment reference. */
export interface BtcPaymentReference {
  /** Transaction id (lowercase, 64 hex chars). */
  txid: Txid;
  /** Output index that pays the seller (vout). Defaults to 0 when unspecified. */
  vout: number;
  /** Destination Bitcoin address (bech32 or base58), if known. */
  address: string | null;
  /** Amount in satoshis (integer smallest-unit). null when not encoded. */
  amountSats: number | null;
  /** Optional human-readable label / message from a BIP21 URI. */
  label: string | null;
  /** Source format the reference was parsed from. */
  source: "bip21" | "outpoint" | "txid";
}

/** Canonical, hashable payment proof body. */
export interface BtcPaymentProof {
  chain: "bitcoin";
  txid: Txid;
  vout: number;
  address: string | null;
  amount_sats: number | null;
  confirmations: number;
}

const TXID_RE = /^[0-9a-fA-F]{64}$/;

/** Deterministic JSON with sorted keys — matches the standards' stableStringify. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Validate and normalize a txid to lowercase hex; throws on malformed input. */
export function normalizeTxid(txid: string): Txid {
  if (typeof txid !== "string" || !TXID_RE.test(txid)) {
    throw new Error(`invalid bitcoin txid: ${String(txid)}`);
  }
  return txid.toLowerCase();
}

/**
 * Convert a BTC amount string (e.g. "0.00125000") to integer satoshis without
 * floating point error. Accepts up to 8 decimal places.
 */
export function btcToSats(btc: string): number {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(btc.trim());
  if (!m) {
    throw new Error(`invalid BTC amount: ${btc}`);
  }
  const whole = m[1];
  const frac = (m[2] ?? "").padEnd(8, "0");
  const sats = BigInt(whole) * 100_000_000n + BigInt(frac);
  if (sats > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`BTC amount too large to represent safely: ${btc}`);
  }
  return Number(sats);
}

/**
 * Parse any supported payment reference string into a normalized descriptor.
 *
 * Supported forms:
 *   - BIP21 URI:  "bitcoin:<address>?amount=0.001&label=Foo&txid=<hex>&vout=1"
 *   - Outpoint:   "<txid>:<vout>"
 *   - Bare txid:  "<64-hex>"
 */
export function parsePaymentReference(reference: string): BtcPaymentReference {
  if (typeof reference !== "string" || reference.length === 0) {
    throw new Error("payment reference must be a non-empty string");
  }
  const trimmed = reference.trim();

  if (trimmed.toLowerCase().startsWith("bitcoin:")) {
    return parseBip21(trimmed);
  }
  if (trimmed.includes(":")) {
    return parseOutpoint(trimmed);
  }
  return {
    txid: normalizeTxid(trimmed),
    vout: 0,
    address: null,
    amountSats: null,
    label: null,
    source: "txid",
  };
}

function parseOutpoint(reference: string): BtcPaymentReference {
  const [txidPart, voutPart] = reference.split(":");
  const vout = Number.parseInt(voutPart ?? "", 10);
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error(`invalid outpoint vout: ${String(voutPart)}`);
  }
  return {
    txid: normalizeTxid(txidPart ?? ""),
    vout,
    address: null,
    amountSats: null,
    label: null,
    source: "outpoint",
  };
}

function parseBip21(reference: string): BtcPaymentReference {
  // bitcoin:<address>?<query>
  const withoutScheme = reference.slice("bitcoin:".length);
  const qIndex = withoutScheme.indexOf("?");
  const address = (qIndex === -1 ? withoutScheme : withoutScheme.slice(0, qIndex)) || null;
  const query = qIndex === -1 ? "" : withoutScheme.slice(qIndex + 1);

  const params = new Map<string, string>();
  for (const pair of query.split("&")) {
    if (pair.length === 0) {
      continue;
    }
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const rawVal = eq === -1 ? "" : pair.slice(eq + 1);
    params.set(decodeURIComponent(key), decodeURIComponent(rawVal));
  }

  const amountStr = params.get("amount");
  const txidStr = params.get("txid");
  const voutStr = params.get("vout");

  if (!txidStr) {
    throw new Error("BIP21 reference is missing a `txid` parameter required for a payment proof");
  }

  const vout = voutStr !== undefined ? Number.parseInt(voutStr, 10) : 0;
  if (!Number.isInteger(vout) || vout < 0) {
    throw new Error(`invalid BIP21 vout: ${String(voutStr)}`);
  }

  return {
    txid: normalizeTxid(txidStr),
    vout,
    address,
    amountSats: amountStr !== undefined ? btcToSats(amountStr) : null,
    label: params.get("label") ?? params.get("message") ?? null,
    source: "bip21",
  };
}

/**
 * Derive the canonical URE-compatible `payment_proof_hash` for a parsed reference.
 *
 * @param ref           parsed payment reference
 * @param confirmations number of confirmations observed (snapshot; default 1)
 * @returns `0x`-prefixed 32-byte sha256 hex digest
 */
export function paymentProofHash(ref: BtcPaymentReference, confirmations = 1): string {
  if (!Number.isInteger(confirmations) || confirmations < 0) {
    throw new Error(`confirmations must be a non-negative integer, got ${confirmations}`);
  }
  const proof: BtcPaymentProof = {
    chain: "bitcoin",
    txid: ref.txid,
    vout: ref.vout,
    address: ref.address,
    amount_sats: ref.amountSats,
    confirmations,
  };
  return "0x" + sha256Hex(stableStringify(proof));
}

/**
 * One-shot helper: parse a reference string and return both the normalized
 * descriptor and the URE-compatible payment proof hash.
 */
export function toUrePaymentProof(
  reference: string,
  confirmations = 1,
): { reference: BtcPaymentReference; payment_proof_hash: string } {
  const parsed = parsePaymentReference(reference);
  return { reference: parsed, payment_proof_hash: paymentProofHash(parsed, confirmations) };
}
