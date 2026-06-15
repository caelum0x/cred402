import type { Ledger } from "../ledger/ledger.js";
import type { ReasonCodeEntry } from "../core/reason_codes.js";

/**
 * RealFi credit signal (p6 §864).
 *
 * Folds off-chain finance evidence (operator verification, fiat receipts, bank
 * cashflow, chargebacks) into a BOUNDED multiplier on an agent's credit cap. The
 * protocol stays Casper-native: RealFi can lift the line at most +20% and is
 * never the foundation — anonymous agents simply get no uplift, while chargebacks
 * cut it. Returns the multiplier plus structured reason codes (p5 §15).
 */

export interface RealFiSignal {
  multiplier: number; // bounded to [MIN, MAX]
  operator_verified: boolean;
  fiat_receipt_count: number;
  bank_verified: boolean;
  chargebacks: number;
  reason_codes: ReasonCodeEntry[];
}

const MIN_MULTIPLIER = 0.6;
const MAX_MULTIPLIER = 1.2; // p6 §911: fiat + operator together cap the uplift

export function realfiCreditSignal(ledger: Ledger, agent_id: string, operator_id?: string): RealFiSignal {
  const reason_codes: ReasonCodeEntry[] = [];
  let multiplier = 1.0;

  // Operator verification (Stripe Identity) — up to +10%.
  const operator_verified = operator_id ? ledger.operators.is_verified(operator_id) : false;
  if (operator_verified) {
    multiplier += 0.1;
    reason_codes.push({ code: "VERIFIED_OPERATOR", polarity: "positive", detail: `operator ${shorten(operator_id!)} verified` });
  } else {
    reason_codes.push({ code: "UNVERIFIED_OPERATOR", polarity: "negative", detail: "no verified operator — Casper-native cap only" });
  }

  // Settled fiat receipts (Stripe billing) — up to +10%, 2% each.
  const fiatReceipts = ledger.fiatReceipts.forSeller(agent_id).filter((r) => r.status === "settled" || r.status === "finalized");
  const fiat_receipt_count = fiatReceipts.length;
  if (fiat_receipt_count > 0) {
    const uplift = Math.min(0.1, fiat_receipt_count * 0.02);
    multiplier += uplift;
    reason_codes.push({ code: "FIAT_REVENUE", polarity: "positive", detail: `${fiat_receipt_count} settled fiat receipt(s)` });
  }

  // Bank cashflow verification (Plaid) — up to +5%.
  const bank_verified = operator_id ? ledger.realfi.forSubject(operator_id, "bank_verification").length > 0 : false;
  if (bank_verified) {
    multiplier += 0.05;
    reason_codes.push({ code: "BANK_CASHFLOW_VERIFIED", polarity: "positive", detail: "Plaid cashflow verified" });
  }

  // Chargebacks — each cuts 15%.
  const chargebacks = operator_id ? ledger.realfi.forSubject(operator_id, "chargeback_signal").length : 0;
  if (chargebacks > 0) {
    multiplier -= chargebacks * 0.15;
    reason_codes.push({ code: "CHARGEBACK_PENALTY", polarity: "negative", detail: `${chargebacks} chargeback signal(s)` });
  }

  multiplier = Math.max(MIN_MULTIPLIER, Math.min(MAX_MULTIPLIER, multiplier));
  return { multiplier, operator_verified, fiat_receipt_count, bank_verified, chargebacks, reason_codes };
}

function shorten(id: string): string {
  return id.length > 14 ? `${id.slice(0, 14)}…` : id;
}
