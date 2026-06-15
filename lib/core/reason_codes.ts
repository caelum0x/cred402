import type { Agent } from "./types.js";

/**
 * Credit reason codes (p5 §15).
 *
 * Structured, judge-friendly explanations attached to every credit decision.
 * Positive codes lift the line; negative codes constrain it. The CreditAgent
 * derives these from real on-chain signals (finalized receipts, verified
 * evidence, stake, disputes, fraud graph, repayment events) so an approval is
 * always explainable: "+12 finalized x402 receipts, − new-agent cap applied".
 */

export type PositiveReasonCode =
  | "FINALIZED_X402_REVENUE"
  | "LOW_DISPUTE_RATE"
  | "VALID_RWA_EVIDENCE"
  | "STAKE_BACKING"
  | "STRONG_REPAYMENT_HISTORY"
  | "SERVICE_CATEGORY_EXPERTISE"
  | "COUNTERPARTY_DIVERSITY"
  // RealFi signals (p6 §864) — supplementary, capped so they never dominate.
  | "VERIFIED_OPERATOR"
  | "FIAT_REVENUE"
  | "BANK_CASHFLOW_VERIFIED";

export type NegativeReasonCode =
  | "NEW_AGENT_LIMIT"
  | "HIGH_DISPUTE_RATE"
  | "LOW_STAKE_COVERAGE"
  | "SUSPICIOUS_RECEIPT_PATTERN"
  | "HIGH_COUNTERPARTY_CONCENTRATION"
  | "OVERDUE_CREDIT"
  | "BAD_EVIDENCE_VERDICT"
  // RealFi signals (p6 §864).
  | "UNVERIFIED_OPERATOR"
  | "CHARGEBACK_PENALTY";

export type ReasonCode = PositiveReasonCode | NegativeReasonCode;

export interface ReasonCodeEntry {
  code: ReasonCode;
  polarity: "positive" | "negative";
  detail: string;
}

/** Pure inputs the reason-code engine reasons over (no ledger coupling). */
export interface ReasonInputs {
  agent: Agent;
  finalizedReceiptCount: number;
  verifiedEvidenceCount: number;
  repaymentCount: number;
  topCounterpartyShare: number; // 0..1
  suspiciousFraudFlags: string[];
  creditLine: bigint;
  overdue: boolean;
  badEvidenceVerdict: boolean;
  /** Below this completed-job count an agent is "new" and capped. */
  newAgentJobThreshold?: number;
  /** At/above this completed-job count an agent earns category expertise. */
  expertiseJobThreshold?: number;
}

const pos = (code: PositiveReasonCode, detail: string): ReasonCodeEntry => ({ code, polarity: "positive", detail });
const neg = (code: NegativeReasonCode, detail: string): ReasonCodeEntry => ({ code, polarity: "negative", detail });

/** Derive the full set of credit reason codes from pure inputs (p5 §15). */
export function reasonCodesFromInputs(i: ReasonInputs): ReasonCodeEntry[] {
  const newAgentThreshold = i.newAgentJobThreshold ?? 10;
  const expertiseThreshold = i.expertiseJobThreshold ?? 50;
  const out: ReasonCodeEntry[] = [];

  // Positive signals.
  if (i.finalizedReceiptCount > 0) {
    out.push(pos("FINALIZED_X402_REVENUE", `${i.finalizedReceiptCount} finalized x402 receipt(s)`));
  }
  if (i.agent.dispute_rate <= 0.03) {
    out.push(pos("LOW_DISPUTE_RATE", `dispute rate ${(i.agent.dispute_rate * 100).toFixed(1)}%`));
  }
  if (i.verifiedEvidenceCount > 0) {
    out.push(pos("VALID_RWA_EVIDENCE", `${i.verifiedEvidenceCount} verified RWA evidence submission(s)`));
  }
  if (i.agent.stake > 0n) {
    out.push(pos("STAKE_BACKING", `${formatStake(i.agent.stake)} CSPR stake backing`));
  }
  if (i.repaymentCount > 0) {
    out.push(pos("STRONG_REPAYMENT_HISTORY", `${i.repaymentCount} on-time repayment(s)`));
  }
  if (i.agent.total_jobs_completed >= expertiseThreshold) {
    out.push(pos("SERVICE_CATEGORY_EXPERTISE", `${i.agent.total_jobs_completed} jobs in ${i.agent.service_type}`));
  }
  if (i.topCounterpartyShare > 0 && i.topCounterpartyShare < 0.5) {
    out.push(pos("COUNTERPARTY_DIVERSITY", `top payer is ${(i.topCounterpartyShare * 100).toFixed(0)}% of income`));
  }

  // Negative / constraining signals.
  if (i.agent.total_jobs_completed < newAgentThreshold) {
    out.push(neg("NEW_AGENT_LIMIT", `only ${i.agent.total_jobs_completed} completed jobs — new-agent cap applied`));
  }
  if (i.agent.dispute_rate > 0.05) {
    out.push(neg("HIGH_DISPUTE_RATE", `dispute rate ${(i.agent.dispute_rate * 100).toFixed(1)}%`));
  }
  if (i.agent.stake < i.creditLine) {
    out.push(neg("LOW_STAKE_COVERAGE", `stake under-covers the ${formatStake(i.creditLine)} CSPR line`));
  }
  if (i.suspiciousFraudFlags.length > 0) {
    out.push(neg("SUSPICIOUS_RECEIPT_PATTERN", `fraud flags: ${i.suspiciousFraudFlags.join(", ")}`));
  }
  if (i.topCounterpartyShare > 0.8) {
    out.push(neg("HIGH_COUNTERPARTY_CONCENTRATION", `${(i.topCounterpartyShare * 100).toFixed(0)}% income from one payer`));
  }
  if (i.overdue) {
    out.push(neg("OVERDUE_CREDIT", `an existing credit line is overdue`));
  }
  if (i.badEvidenceVerdict) {
    out.push(neg("BAD_EVIDENCE_VERDICT", `a dispute resolved against this agent's evidence`));
  }

  return out;
}

function formatStake(motes: bigint): string {
  return (Number(motes) / 1e9).toFixed(0);
}
