import type { Ledger } from "../ledger/ledger.js";
import { hashObject } from "../core/hash.js";
import {
  buildFiatReceipt,
  buildOperatorVerification,
  buildBankVerification,
  hashSecret,
  type FiatProvider,
  type FiatSettlementStatus,
  type FiatReceiptEnvelope,
  type OperatorVerificationEnvelope,
  type BankVerificationEnvelope,
  type VerificationLevel,
  type VerificationStatus,
} from "../realfi/envelopes.js";
import type { FiatReceipt } from "../ledger/contracts/fiat_receipt_registry.js";
import type { OperatorVerification } from "../ledger/contracts/operator_verification_registry.js";
import type { RealFiAttestation } from "../ledger/contracts/realfi_attestation_registry.js";

/**
 * Cred402 RealFi Bridge (p6).
 *
 * The product module that brings fiat finance (Stripe billing, Stripe Identity,
 * Plaid bank data) into the agent economy WITHOUT leaking PII on-chain. Raw
 * provider payloads stay off-chain; the bridge converts them into hashed,
 * standardized envelopes (FRE / OVE / BVE) and commits those to the Casper-rooted
 * registries. The live Stripe/Plaid API call is the integration boundary — this
 * bridge owns everything from "provider gave me an event" to "commitment on
 * Casper", which is the part that must be correct and private.
 */
export class RealFiBridge {
  constructor(private readonly ledger: Ledger) {}

  /** Stripe webhook (charge.succeeded) → privacy-preserving on-chain fiat receipt. */
  recordFiatReceipt(input: {
    provider?: FiatProvider;
    provider_event_id: string; // raw Stripe event id — hashed here, never stored raw
    provider_receipt_id: string; // raw receipt/charge id — hashed here
    payer_type: string;
    seller_agent: string;
    operator_id: string;
    amount: string;
    currency: string;
    service_type: string;
    request_hash: string;
    result_hash: string;
    settlement_status?: FiatSettlementStatus;
  }): { receipt_id: string; envelope: FiatReceiptEnvelope; record: FiatReceipt } {
    const { envelope, receipt_id } = buildFiatReceipt({
      provider: input.provider ?? "stripe",
      provider_event_id_hash: hashSecret(input.provider_event_id),
      payer_type: input.payer_type,
      seller_agent: input.seller_agent,
      operator_id: input.operator_id,
      amount: input.amount,
      currency: input.currency,
      service_type: input.service_type,
      request_hash: input.request_hash,
      result_hash: input.result_hash,
      provider_receipt_hash: hashSecret(input.provider_receipt_id),
      settlement_status: input.settlement_status ?? "settled",
      created_at: this.ledger.clock.now(),
    });
    const record = this.ledger.fiatReceipts.record_fiat_receipt(envelope, receipt_id);
    return { receipt_id, envelope, record };
  }

  /** Stripe Identity result → operator verification attestation. */
  verifyOperator(input: {
    operator_id: string;
    provider?: string;
    verification_level: VerificationLevel;
    jurisdiction: string;
    verification_status?: VerificationStatus;
    verification_reference: string; // raw KYB reference — hashed here
    valid_days?: number;
  }): { attestation_hash: string; envelope: OperatorVerificationEnvelope; record: OperatorVerification } {
    const now = this.ledger.clock.now();
    const { envelope, attestation_hash } = buildOperatorVerification({
      operator_id: input.operator_id,
      provider: input.provider ?? "stripe_identity",
      verification_level: input.verification_level,
      jurisdiction: input.jurisdiction,
      verification_status: input.verification_status ?? "verified",
      verification_reference_hash: hashSecret(input.verification_reference),
      verified_at: now,
      expires_at: now + (input.valid_days ?? 365) * 24 * 60 * 60,
    });
    const record = this.ledger.operators.record_operator_verification(envelope, attestation_hash);
    return { attestation_hash, envelope, record };
  }

  /** Plaid cashflow/balance report → bank verification attestation. */
  recordBankVerification(input: {
    operator_id: string;
    provider?: string;
    account_ownership_verified: boolean;
    cashflow_report: unknown; // raw report — hashed here, never stored
    balance_snapshot: unknown; // raw snapshot — hashed here
    data_period_start: number;
    data_period_end: number;
    valid_days?: number;
  }): { attestation_hash: string; envelope: BankVerificationEnvelope; record: RealFiAttestation } {
    const now = this.ledger.clock.now();
    const { envelope, attestation_hash } = buildBankVerification({
      provider: input.provider ?? "plaid",
      operator_id: input.operator_id,
      account_ownership_verified: input.account_ownership_verified,
      cashflow_report_hash: hashObject(input.cashflow_report),
      balance_snapshot_hash: hashObject(input.balance_snapshot),
      data_period_start: input.data_period_start,
      data_period_end: input.data_period_end,
      created_at: now,
    });
    const record = this.ledger.realfi.record_attestation({
      attestation_id: attestation_hash,
      attestation_type: "bank_verification",
      subject_id: input.operator_id,
      provider: envelope.provider,
      attestation_hash,
      expires_at: now + (input.valid_days ?? 90) * 24 * 60 * 60,
    });
    return { attestation_hash, envelope, record };
  }

  /** Stripe chargeback/dispute webhook → a negative chargeback signal attestation. */
  recordChargeback(input: {
    operator_id: string;
    provider?: string;
    dispute_reference: string;
    valid_days?: number;
  }): RealFiAttestation {
    const now = this.ledger.clock.now();
    const attestation_hash = hashSecret(`chargeback:${input.dispute_reference}`);
    return this.ledger.realfi.record_attestation({
      attestation_id: attestation_hash,
      attestation_type: "chargeback_signal",
      subject_id: input.operator_id,
      provider: input.provider ?? "stripe",
      attestation_hash,
      expires_at: now + (input.valid_days ?? 180) * 24 * 60 * 60,
    });
  }
}
