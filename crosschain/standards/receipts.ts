import { blake2b256, stableStringify } from "../../lib/core/hash.js";

/**
 * URE — Universal Receipt Envelope (p3 §3). Every x402 payment on any chain
 * becomes a universal receipt whose canonical ID anchors to Casper:
 *
 *   receipt_id = blake2b256(canonical_json(UniversalReceiptEnvelope))
 */
export interface UniversalReceiptEnvelope {
  type: "Cred402Receipt";
  version: "1";
  origin_chain: string; // e.g. "eip155:8453"
  settlement_network: string; // e.g. "base"
  payer_agent_id: string;
  seller_agent_id: string;
  payer_address: string;
  seller_address: string;
  asset: string; // "USDC" | "CSPR" | ...
  amount: string; // smallest-unit integer string
  service_type: string;
  request_hash: string;
  result_hash: string;
  payment_proof_hash: string;
  settlement_tx_hash: string;
  nonce: string;
  created_at: number;
}

export function makeReceiptId(ure: UniversalReceiptEnvelope): string {
  return blake2b256(stableStringify(ure));
}

export function buildUniversalReceipt(
  fields: Omit<UniversalReceiptEnvelope, "type" | "version">,
): { envelope: UniversalReceiptEnvelope; receipt_id: string } {
  const envelope: UniversalReceiptEnvelope = { type: "Cred402Receipt", version: "1", ...fields };
  return { envelope, receipt_id: makeReceiptId(envelope) };
}

/** Validate structural integrity + recompute the canonical receipt id. */
export function verifyUniversalReceipt(ure: UniversalReceiptEnvelope, claimedId: string): { ok: boolean; reason?: string } {
  if (ure.type !== "Cred402Receipt") return { ok: false, reason: "wrong type" };
  for (const k of ["origin_chain", "payer_agent_id", "seller_agent_id", "amount", "service_type", "payment_proof_hash", "nonce"] as const) {
    if (!ure[k]) return { ok: false, reason: `missing ${k}` };
  }
  if (!/^\d+$/.test(ure.amount)) return { ok: false, reason: "amount must be an integer string" };
  if (makeReceiptId(ure) !== claimedId) return { ok: false, reason: "receipt_id mismatch" };
  return { ok: true };
}
