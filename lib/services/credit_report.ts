import type { Ledger } from "../ledger/ledger.js";
import { FraudService } from "./fraud_service.js";
import { ComplianceService } from "../compliance/service.js";
import { reasonCodesFromInputs } from "../core/reason_codes.js";
import { realfiCreditSignal } from "./realfi_credit.js";
import { last30DayRevenue } from "../core/risk_policy.js";
import { scaleMotes } from "../core/units.js";

/**
 * Agent credit report — the bureau's headline artifact.
 *
 * A formal, FICO-style report for one agent: a score + band, estimated default
 * probability and recommended terms, the positive/negative factors driving the
 * score, payment history, public records (disputes + slashing), credit
 * inquiries, a revenue summary, and the compliance verdict. Composed entirely
 * from canonical on-chain state — fully explainable, no black box.
 */

export type ScoreBand = "poor" | "fair" | "good" | "very_good" | "excellent";

export interface CreditReport {
  agent_id: string;
  generated_at: number;
  credit_score: number;
  score_band: ScoreBand;
  pd_estimate: number; // 0..1 rough probability of default
  recommended_terms: { credit_line_motes: string; interest_rate_bps: number };
  factors: { positive: Array<{ code: string; detail: string }>; negative: Array<{ code: string; detail: string }> };
  payment_history: {
    receipts_total: number;
    receipts_finalized: number;
    receipts_disputed: number;
    repayments: number;
    on_time_rate: number;
  };
  public_records: {
    disputes: Array<{ dispute_id: string; type: string; status: string; verdict?: string }>;
    slashes: Array<{ amount_motes: string; reason: string }>;
  };
  inquiries: Array<{ seq: number; credit_score: number }>;
  revenue_summary: { revenue_30d_motes: string; revenue_total_motes: string; jobs_completed: number };
  compliance: { cleared: boolean; checks: Array<{ name: string; passed: boolean; detail: string }> };
}

function band(score: number): ScoreBand {
  if (score >= 90) return "excellent";
  if (score >= 75) return "very_good";
  if (score >= 60) return "good";
  if (score >= 40) return "fair";
  return "poor";
}

export function generateCreditReport(ledger: Ledger, agentId: string): CreditReport | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const now = ledger.clock.now();
  const fraud = new FraudService(ledger).analyze(agentId);
  const decision = ledger.policy.evaluate(agent);
  const operatorId = ledger.buildPassport(agentId)?.operator;
  const realfi = realfiCreditSignal(ledger, agentId, operatorId);

  const receipts = ledger.receipts.forSeller(agentId);
  const finalized = receipts.filter((r) => r.status === "finalized");
  const disputed = receipts.filter((r) => r.status === "disputed");
  const repayments = ledger.bus.all().filter((e) => e.name === "CreditRepaid" && (e.data as { agent_id?: string }).agent_id === agentId).length;
  const existing = ledger.pool.get(agentId);

  const codes = reasonCodesFromInputs({
    agent,
    finalizedReceiptCount: finalized.length,
    verifiedEvidenceCount: ledger.evidence.list().filter((e) => e.agent_id === agentId && e.verified).length,
    repaymentCount: repayments,
    topCounterpartyShare: fraud.top_counterparty_share,
    suspiciousFraudFlags: fraud.flags.map((f) => f.code),
    creditLine: decision.credit_line,
    overdue: existing !== undefined && existing.drawn > 0n && existing.due_timestamp < now,
    badEvidenceVerdict: ledger.disputes.forAgent(agentId).some((d) => d.verdict === "agent_loses"),
  }).concat(realfi.reason_codes);

  const credit_score = decision.credit_score;
  // Rough PD: blend score deficit with fraud risk.
  const pd_estimate = Math.min(0.99, Math.max(0.01, (100 - credit_score) / 100 * 0.7 + (fraud.score / 100) * 0.3));

  return {
    agent_id: agentId,
    generated_at: now,
    credit_score,
    score_band: band(credit_score),
    pd_estimate: Math.round(pd_estimate * 1000) / 1000,
    recommended_terms: {
      credit_line_motes: scaleMotes(decision.credit_line, realfi.multiplier).toString(),
      interest_rate_bps: decision.interest_rate_bps,
    },
    factors: {
      positive: codes.filter((c) => c.polarity === "positive").map((c) => ({ code: c.code, detail: c.detail })),
      negative: codes.filter((c) => c.polarity === "negative").map((c) => ({ code: c.code, detail: c.detail })),
    },
    payment_history: {
      receipts_total: receipts.length,
      receipts_finalized: finalized.length,
      receipts_disputed: disputed.length,
      repayments,
      on_time_rate: receipts.length ? Math.round((finalized.length / receipts.length) * 1000) / 1000 : 1,
    },
    public_records: {
      disputes: ledger.disputes.forAgent(agentId).map((d) => ({ dispute_id: d.dispute_id, type: d.dispute_type, status: d.status, verdict: d.verdict })),
      slashes: ledger.slashing.list().filter((s) => s.agent_id === agentId).map((s) => ({ amount_motes: s.amount.toString(), reason: s.reason })),
    },
    inquiries: ledger.bus
      .all()
      .filter((e) => e.name === "CreditScoreSet" && (e.data as { agent_id?: string }).agent_id === agentId)
      .map((e) => ({ seq: e.seq, credit_score: Number((e.data as { credit_score?: number }).credit_score ?? 0) })),
    revenue_summary: {
      revenue_30d_motes: last30DayRevenue(agent.x402_revenue_history, now).toString(),
      revenue_total_motes: agent.x402_revenue_history.reduce((s, e) => s + e.amount, 0n).toString(),
      jobs_completed: agent.total_jobs_completed,
    },
    compliance: (() => {
      const screen = new ComplianceService(ledger).screenAgent(agentId);
      return { cleared: screen.cleared, checks: screen.checks };
    })(),
  };
}
