import type { Ledger } from "../ledger/ledger.js";
import type { Agent, RevenueEvent, ServiceType } from "../core/types.js";
import type { CreditDecision } from "../core/risk_policy.js";
import { reasonCodesFromInputs } from "../core/reason_codes.js";
import { cspr } from "../core/units.js";

/**
 * Credit underwriting simulator — a read-only "what-if" preview. Integrators (and
 * the console) can ask "what credit line would an agent with these signals get?"
 * WITHOUT registering an agent or mutating the ledger. It runs the exact live risk
 * policy + governance exposure cap against a synthetic agent built from the inputs,
 * so the preview matches what real underwriting would produce.
 */

export interface SimulationInput {
  /** 30-day x402 revenue in CSPR (the policy's primary signal). */
  monthly_revenue_cspr: number;
  /** Staked CSPR (boosts the line via the stake multiplier). */
  stake_cspr?: number;
  /** 0..100 reputation. */
  reputation?: number;
  /** 0..100 evidence accuracy. */
  accuracy?: number;
  /** 0..1 fraction of receipts disputed. */
  dispute_rate?: number;
  /** Lifetime jobs completed. */
  jobs_completed?: number;
  service_type?: string;
}

export interface SimulationResult {
  input: Required<Omit<SimulationInput, "service_type">> & { service_type: string };
  decision: CreditDecision;
  estimated_credit_line_cspr: number;
  governance_capped: boolean;
  eligible: boolean;
  ineligible_reason?: string;
}

const MOTES_PER_CSPR = 1_000_000_000;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function simulateUnderwriting(ledger: Ledger, input: SimulationInput): SimulationResult {
  const now = ledger.clock.now();
  const reputation = clamp(input.reputation ?? 70, 0, 100);
  const accuracy = clamp(input.accuracy ?? 90, 0, 100);
  const dispute_rate = clamp(input.dispute_rate ?? 0.01, 0, 1);
  const jobs_completed = Math.max(0, Math.trunc(input.jobs_completed ?? 50));
  const stake_cspr = Math.max(0, input.stake_cspr ?? 0);
  const monthly_revenue_cspr = Math.max(0, input.monthly_revenue_cspr);
  const service_type = (input.service_type ?? "rwa.weather_risk") as ServiceType;

  // One synthetic revenue event inside the 30-day window carries the full revenue.
  const revenue_history: RevenueEvent[] = monthly_revenue_cspr > 0
    ? [{ receipt_id: "sim-receipt", amount: cspr(monthly_revenue_cspr), timestamp: now - 1, service_type }]
    : [];

  const synthetic: Agent = {
    agent_id: "__simulation__",
    owner_public_key: "00",
    agent_public_key: "00",
    service_type,
    stake: cspr(stake_cspr),
    total_jobs_completed: jobs_completed,
    x402_revenue_history: revenue_history,
    accuracy_score: accuracy,
    dispute_rate,
    reputation_score: reputation,
    credit_score: 0,
    active: true,
    registered_at: now,
  };

  const decision = ledger.policy.evaluate(synthetic);

  // Apply the same governance exposure cap the live underwriter applies.
  const gov = ledger.governance.get();
  const uncapped = decision.credit_line;
  const capped = uncapped > gov.max_agent_exposure ? gov.max_agent_exposure : uncapped;
  const governance_capped = capped !== uncapped;
  decision.credit_line = capped;

  // Eligibility mirrors the live underwriter's pre-draw gates (no fraud/compliance
  // history exists for a synthetic agent, so we check the deterministic ones).
  let eligible = true;
  let ineligible_reason: string | undefined;
  if (reputation < gov.min_reputation_to_draw) {
    eligible = false;
    ineligible_reason = `reputation ${reputation} below minimum ${gov.min_reputation_to_draw}`;
  }

  decision.reason_codes = reasonCodesFromInputs({
    agent: synthetic,
    finalizedReceiptCount: monthly_revenue_cspr > 0 ? 1 : 0,
    verifiedEvidenceCount: jobs_completed > 0 ? 1 : 0,
    repaymentCount: 0,
    topCounterpartyShare: 0,
    suspiciousFraudFlags: [],
    creditLine: capped,
    overdue: false,
    badEvidenceVerdict: false,
  });

  return {
    input: { monthly_revenue_cspr, stake_cspr, reputation, accuracy, dispute_rate, jobs_completed, service_type },
    decision,
    estimated_credit_line_cspr: Number(capped) / MOTES_PER_CSPR,
    governance_capped,
    eligible,
    ineligible_reason,
  };
}
