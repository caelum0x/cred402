import { blake2b256, stableStringify } from "../core/hash.js";

/**
 * Cred402 RealFi Bridge envelopes (p6).
 *
 * Standardized, privacy-preserving commitments for off-chain finance evidence
 * (Stripe fiat receipts, Stripe Identity operator verification, Plaid bank data).
 * The rule (p6): NEVER put raw PII on-chain — no Stripe event ids, emails, card
 * or bank details. Only hashes, provider name, status, agent/operator id, service
 * type, timestamps and (optionally) a coarse amount bucket. Use {@link hashSecret}
 * to commit any sensitive value before it enters an envelope.
 */

/** Commit a sensitive value (provider id, account ref) to a one-way hash. */
export function hashSecret(value: string): string {
  return blake2b256(`cred402:realfi:${value}`);
}

// ---------------------------------------------------------------------------
// FRE — Fiat Receipt Envelope (the Stripe-equivalent of an x402 receipt)
// ---------------------------------------------------------------------------

export type FiatProvider = "stripe" | "adyen" | "checkout" | "braintree";
export type FiatSettlementStatus = "pending" | "settled" | "refunded" | "disputed";

export interface FiatReceiptEnvelope {
  type: "Cred402FiatReceiptEnvelope";
  version: "1.0";
  provider: FiatProvider;
  provider_event_id_hash: string;
  payer_type: string; // e.g. "enterprise_customer"
  seller_agent: string; // CAID
  operator_id: string;
  amount: string; // decimal string, public bucket acceptable
  currency: string; // ISO 4217
  service_type: string;
  request_hash: string;
  result_hash: string;
  provider_receipt_hash: string;
  settlement_status: FiatSettlementStatus;
  created_at: number;
}

export function makeFiatReceiptId(fre: FiatReceiptEnvelope): string {
  return blake2b256(stableStringify(fre));
}

export function buildFiatReceipt(
  fields: Omit<FiatReceiptEnvelope, "type" | "version">,
): { envelope: FiatReceiptEnvelope; receipt_id: string } {
  const envelope: FiatReceiptEnvelope = { type: "Cred402FiatReceiptEnvelope", version: "1.0", ...fields };
  return { envelope, receipt_id: makeFiatReceiptId(envelope) };
}

export function verifyFiatReceipt(fre: FiatReceiptEnvelope, claimedId: string): { ok: boolean; reason?: string } {
  if (fre.type !== "Cred402FiatReceiptEnvelope") return { ok: false, reason: "wrong type" };
  for (const k of ["provider", "seller_agent", "operator_id", "amount", "currency", "service_type", "provider_receipt_hash"] as const) {
    if (!fre[k]) return { ok: false, reason: `missing ${k}` };
  }
  if (!/^\d+(\.\d+)?$/.test(fre.amount)) return { ok: false, reason: "amount must be a decimal string" };
  if (containsLikelyPii(fre.provider_event_id_hash)) return { ok: false, reason: "provider_event_id must be hashed" };
  if (makeFiatReceiptId(fre) !== claimedId) return { ok: false, reason: "receipt_id mismatch" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// OVE — Operator Verification Envelope (real business ↔ agent linkage)
// ---------------------------------------------------------------------------

export type VerificationLevel = "unverified" | "email_verified" | "business_verified" | "regulated_entity";
export type VerificationStatus = "pending" | "verified" | "rejected" | "revoked";

export interface OperatorVerificationEnvelope {
  type: "Cred402OperatorVerificationEnvelope";
  version: "1.0";
  operator_id: string;
  provider: string; // e.g. "stripe_identity"
  verification_level: VerificationLevel;
  jurisdiction: string; // ISO 3166 alpha-2
  verification_status: VerificationStatus;
  verification_reference_hash: string;
  verified_at: number;
  expires_at: number;
}

export function makeOperatorVerificationId(ove: OperatorVerificationEnvelope): string {
  return blake2b256(stableStringify(ove));
}

export function buildOperatorVerification(
  fields: Omit<OperatorVerificationEnvelope, "type" | "version">,
): { envelope: OperatorVerificationEnvelope; attestation_hash: string } {
  const envelope: OperatorVerificationEnvelope = { type: "Cred402OperatorVerificationEnvelope", version: "1.0", ...fields };
  return { envelope, attestation_hash: makeOperatorVerificationId(envelope) };
}

export function verifyOperatorVerification(ove: OperatorVerificationEnvelope, now: number): { ok: boolean; reason?: string } {
  if (ove.type !== "Cred402OperatorVerificationEnvelope") return { ok: false, reason: "wrong type" };
  if (!ove.operator_id || !ove.provider) return { ok: false, reason: "missing operator/provider" };
  if (ove.expires_at <= now) return { ok: false, reason: "verification expired" };
  if (containsLikelyPii(ove.verification_reference_hash)) return { ok: false, reason: "reference must be hashed" };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// BVE — Bank Verification Envelope (Plaid-style cashflow evidence)
// ---------------------------------------------------------------------------

export interface BankVerificationEnvelope {
  type: "Cred402BankVerificationEnvelope";
  version: "1.0";
  provider: string; // e.g. "plaid"
  operator_id: string;
  account_ownership_verified: boolean;
  cashflow_report_hash: string;
  balance_snapshot_hash: string;
  data_period_start: number;
  data_period_end: number;
  created_at: number;
}

export function makeBankVerificationId(bve: BankVerificationEnvelope): string {
  return blake2b256(stableStringify(bve));
}

export function buildBankVerification(
  fields: Omit<BankVerificationEnvelope, "type" | "version">,
): { envelope: BankVerificationEnvelope; attestation_hash: string } {
  const envelope: BankVerificationEnvelope = { type: "Cred402BankVerificationEnvelope", version: "1.0", ...fields };
  return { envelope, attestation_hash: makeBankVerificationId(envelope) };
}

export function verifyBankVerification(bve: BankVerificationEnvelope): { ok: boolean; reason?: string } {
  if (bve.type !== "Cred402BankVerificationEnvelope") return { ok: false, reason: "wrong type" };
  if (!bve.operator_id || !bve.provider) return { ok: false, reason: "missing operator/provider" };
  if (bve.data_period_end <= bve.data_period_start) return { ok: false, reason: "invalid data period" };
  if (containsLikelyPii(bve.cashflow_report_hash) || containsLikelyPii(bve.balance_snapshot_hash)) {
    return { ok: false, reason: "bank data must be hashed" };
  }
  return { ok: true };
}

/** Heuristic guard: a "hash" field must look like a 0x blake2b hash, not raw PII. */
function containsLikelyPii(value: string): boolean {
  if (!value) return false;
  return !/^0x[0-9a-f]{64}$/i.test(value);
}
