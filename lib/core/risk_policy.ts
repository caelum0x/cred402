import type { Agent, RevenueEvent } from "./types.js";
import type { ReasonCodeEntry } from "./reason_codes.js";
import { scaleMotes } from "./units.js";

/**
 * RiskPolicyManager — the upgradable underwriting brain.
 *
 * Casper's upgradable-contract story lets the credit policy evolve from v1 to v2
 * WITHOUT redeploying the rest of the system. We model that by registering
 * multiple pure policy functions and letting the manager switch the active one.
 *
 *   credit_line = base_limit
 *               * stake_multiplier
 *               * dispute_penalty
 *               * accuracy_multiplier
 */

export interface CreditDecision {
  policy_version: string;
  last_30_day_revenue: bigint;
  base_limit: bigint;
  stake_multiplier: number;
  dispute_penalty: number;
  accuracy_multiplier: number;
  credit_line: bigint;
  interest_rate_bps: number;
  credit_score: number; // 0..100
  rationale: string[];
  /** Structured, judge-friendly reason codes (p5 §15), set during underwriting. */
  reason_codes?: ReasonCodeEntry[];
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

export function last30DayRevenue(history: RevenueEvent[], now: number): bigint {
  const cutoff = now - THIRTY_DAYS_SECONDS;
  return history
    .filter((e) => e.timestamp >= cutoff)
    .reduce((sum, e) => sum + e.amount, 0n);
}

export type PolicyFn = (agent: Agent, now: number) => CreditDecision;

/** Policy v1 — exactly the formula from the spec. */
export const policyV1: PolicyFn = (agent, now) => {
  const revenue = last30DayRevenue(agent.x402_revenue_history, now);
  const base_limit = scaleMotes(revenue, 0.3);

  // stake_multiplier = min(2.0, 1 + stake/100 CSPR)
  const stakeCspr = Number(agent.stake) / 1e9;
  const stake_multiplier = Math.min(2.0, 1 + stakeCspr / 100);

  // dispute_penalty = max(0.2, 1 - dispute_rate * 5)
  const dispute_penalty = Math.max(0.2, 1 - agent.dispute_rate * 5);

  // accuracy_multiplier = accuracy_score / 100
  const accuracy_multiplier = agent.accuracy_score / 100;

  const ratio = stake_multiplier * dispute_penalty * accuracy_multiplier;
  const credit_line = scaleMotes(base_limit, ratio);

  const credit_score = clampScore(
    0.5 * agent.accuracy_score +
      0.3 * agent.reputation_score +
      0.2 * (100 - agent.dispute_rate * 100),
  );

  return {
    policy_version: "v1",
    last_30_day_revenue: revenue,
    base_limit,
    stake_multiplier,
    dispute_penalty,
    accuracy_multiplier,
    credit_line,
    interest_rate_bps: interestFromScore(credit_score),
    credit_score,
    rationale: buildRationale(agent, stake_multiplier, dispute_penalty, accuracy_multiplier),
  };
};

/**
 * Policy v2 — the upgrade. Rewards proven job throughput (revenue velocity) and
 * is gentler on stake while harsher on disputes. Demonstrates that risk policy
 * can be hot-swapped on Casper without touching the pool or registry contracts.
 */
export const policyV2: PolicyFn = (agent, now) => {
  const revenue = last30DayRevenue(agent.x402_revenue_history, now);
  // v2 base uses 0.35 of revenue and adds a small throughput bonus.
  const base_limit = scaleMotes(revenue, 0.35);

  const stakeCspr = Number(agent.stake) / 1e9;
  const stake_multiplier = Math.min(1.6, 1 + stakeCspr / 150);

  // Harsher dispute penalty (x8 instead of x5).
  const dispute_penalty = Math.max(0.15, 1 - agent.dispute_rate * 8);
  const accuracy_multiplier = agent.accuracy_score / 100;

  // Throughput bonus: more completed jobs => slightly higher line, capped.
  const throughput_bonus = Math.min(1.25, 1 + agent.total_jobs_completed / 1000);

  const ratio = stake_multiplier * dispute_penalty * accuracy_multiplier * throughput_bonus;
  const credit_line = scaleMotes(base_limit, ratio);

  const credit_score = clampScore(
    0.45 * agent.accuracy_score +
      0.25 * agent.reputation_score +
      0.2 * (100 - agent.dispute_rate * 100) +
      0.1 * Math.min(100, agent.total_jobs_completed / 5),
  );

  const rationale = buildRationale(agent, stake_multiplier, dispute_penalty, accuracy_multiplier);
  rationale.push(`throughput bonus x${throughput_bonus.toFixed(2)} (${agent.total_jobs_completed} jobs)`);

  return {
    policy_version: "v2",
    last_30_day_revenue: revenue,
    base_limit,
    stake_multiplier,
    dispute_penalty,
    accuracy_multiplier,
    credit_line,
    interest_rate_bps: interestFromScore(credit_score),
    credit_score,
    rationale,
  };
};

export const POLICIES: Record<string, PolicyFn> = {
  v1: policyV1,
  v2: policyV2,
};

function clampScore(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)));
}

/** Higher score => cheaper credit. Ranges ~8% APR (great) to ~22% APR (weak). */
function interestFromScore(score: number): number {
  const apr = 0.22 - (score / 100) * 0.14; // 0.22 down to 0.08
  return Math.round(apr * 10_000); // bps
}

function buildRationale(
  agent: Agent,
  stake_multiplier: number,
  dispute_penalty: number,
  accuracy_multiplier: number,
): string[] {
  const r: string[] = [];
  r.push(`30-day x402 revenue underpins the base limit`);
  r.push(`stake multiplier x${stake_multiplier.toFixed(2)} (staked collateral)`);
  if (agent.dispute_rate <= 0.03) r.push(`low dispute rate (${(agent.dispute_rate * 100).toFixed(1)}%)`);
  else r.push(`dispute penalty x${dispute_penalty.toFixed(2)} (${(agent.dispute_rate * 100).toFixed(1)}% disputes)`);
  r.push(`evidence accuracy ${agent.accuracy_score}/100 (x${accuracy_multiplier.toFixed(2)})`);
  return r;
}
