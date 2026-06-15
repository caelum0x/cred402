import { stableStringify, blake2b256 } from "../../lib/core/hash.js";
import { sign as edSign, verifyCasperHex } from "../../lib/x402/keys.js";

/**
 * CAN — Credit Authorization Note (p3 §6). The most important multichain credit
 * object: a short-lived, Casper-policy-signed permission that lets a satellite
 * chain open or modify a credit line for an agent up to a global-exposure-checked
 * limit. Satellite pools must NOT lend without a valid CAN.
 */
export interface CreditAuthorizationNote {
  type: "Cred402CreditAuthorizationNote";
  version: "1";
  note_id: string;
  agent_id: string;
  target_chain: string; // e.g. "eip155:8453"
  target_pool: string; // satellite vault address
  max_draw: string; // smallest-unit integer string
  asset: string; // "USDC" ...
  credit_score: number;
  risk_policy_version: number;
  global_exposure_after_draw: string;
  expires_at: number;
  nonce: string;
  casper_policy_signature?: string;
}

export function noteSigningPayload(can: CreditAuthorizationNote): string {
  const { casper_policy_signature, ...unsigned } = can;
  void casper_policy_signature;
  return stableStringify(unsigned);
}

export function buildCreditAuthorizationNote(
  fields: Omit<CreditAuthorizationNote, "type" | "version" | "note_id" | "casper_policy_signature"> & { note_id?: string },
  policyCasperPrivatePem: string,
): CreditAuthorizationNote {
  const note_id =
    fields.note_id ?? "can:" + blake2b256(`${fields.agent_id}:${fields.target_chain}:${fields.nonce}:${fields.expires_at}`).slice(2, 34);
  const base: CreditAuthorizationNote = {
    type: "Cred402CreditAuthorizationNote",
    version: "1",
    note_id,
    agent_id: fields.agent_id,
    target_chain: fields.target_chain,
    target_pool: fields.target_pool,
    max_draw: fields.max_draw,
    asset: fields.asset,
    credit_score: fields.credit_score,
    risk_policy_version: fields.risk_policy_version,
    global_exposure_after_draw: fields.global_exposure_after_draw,
    expires_at: fields.expires_at,
    nonce: fields.nonce,
  };
  return { ...base, casper_policy_signature: edSign(policyCasperPrivatePem, noteSigningPayload(base)) };
}

/** Satellite-side verification: signature + expiry + target match. */
export function verifyCreditAuthorizationNote(
  can: CreditAuthorizationNote,
  policyCasperPubHex: string,
  ctx: { now: number; target_chain: string; target_pool: string },
): { ok: boolean; reason?: string } {
  if (can.type !== "Cred402CreditAuthorizationNote") return { ok: false, reason: "wrong type" };
  if (!can.casper_policy_signature) return { ok: false, reason: "missing policy signature" };
  if (ctx.now > can.expires_at) return { ok: false, reason: "note expired" };
  if (can.target_chain !== ctx.target_chain) return { ok: false, reason: "wrong target chain" };
  if (can.target_pool.toLowerCase() !== ctx.target_pool.toLowerCase()) return { ok: false, reason: "wrong target pool" };
  if (!/^\d+$/.test(can.max_draw)) return { ok: false, reason: "max_draw must be an integer string" };
  if (!verifyCasperHex(policyCasperPubHex, noteSigningPayload(can), can.casper_policy_signature)) {
    return { ok: false, reason: "invalid casper policy signature" };
  }
  return { ok: true };
}
