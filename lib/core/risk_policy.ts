import type { Agent, RevenueEvent } from "./types.js";
import type { ReasonCodeEntry } from "./reason_codes.js";
import { scaleMotes } from "./units.js";
import { categoryRiskMultiplier } from "./service_categories.js";

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
  const total = history
    .filter((e) => e.timestamp >= cutoff)
    .reduce((sum, e) => sum + e.amount, 0n);
  // Revenue underpins the credit line: never let malformed (negative) receipt
  // amounts drive it below zero, which would corrupt the base limit.
  return total > 0n ? total : 0n;
}

function clampNumber(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Normalized, in-domain agent metrics for underwriting.
 *
 * The credit policy converts these directly into a credit line (real money), so
 * we never trust the raw fields — an out-of-range `accuracy_score`, a negative
 * `dispute_rate`, or a negative `stake` (from bad data or a hostile registrant)
 * would otherwise inflate or invert the line. Every value is clamped to the
 * documented domain from `Agent` before it reaches a formula. For already-valid
 * inputs this is the identity, so existing decisions are unchanged.
 */
interface NormalizedMetrics {
  stake_cspr: number; // >= 0
  dispute_rate: number; // 0..1
  accuracy_score: number; // 0..100
  reputation_score: number; // 0..100
  total_jobs_completed: number; // integer >= 0
}

function normalizeMetrics(agent: Agent): NormalizedMetrics {
  const stakeMotes = agent.stake > 0n ? agent.stake : 0n;
  const jobs = Number(agent.total_jobs_completed);
  return {
    stake_cspr: Number(stakeMotes) / 1e9,
    dispute_rate: clampNumber(agent.dispute_rate, 0, 1),
    accuracy_score: clampNumber(agent.accuracy_score, 0, 100),
    reputation_score: clampNumber(agent.reputation_score, 0, 100),
    total_jobs_completed: Number.isFinite(jobs) ? Math.max(0, Math.floor(jobs)) : 0,
  };
}

export type PolicyFn = (agent: Agent, now: number) => CreditDecision;

/** Policy v1 — exactly the formula from the spec. */
export const policyV1: PolicyFn = (agent, now) => {
  const m = normalizeMetrics(agent);
  const revenue = last30DayRevenue(agent.x402_revenue_history, now);
  const base_limit = scaleMotes(revenue, 0.3);

  // stake_multiplier = min(2.0, 1 + stake/100 CSPR)
  const stake_multiplier = Math.min(2.0, 1 + m.stake_cspr / 100);

  // dispute_penalty = max(0.2, 1 - dispute_rate * 5)
  const dispute_penalty = Math.max(0.2, 1 - m.dispute_rate * 5);

  // accuracy_multiplier = accuracy_score / 100
  const accuracy_multiplier = m.accuracy_score / 100;

  // category_multiplier (p1): scale by the service category's credit-risk weight,
  // so credit works for ANY x402 service, weighted by its category — not just RWA.
  const category_multiplier = categoryRiskMultiplier(agent.service_type);
  const ratio = stake_multiplier * dispute_penalty * accuracy_multiplier * category_multiplier;
  const credit_line = clampMotes(scaleMotes(base_limit, ratio));

  const credit_score = clampScore(
    0.5 * m.accuracy_score +
      0.3 * m.reputation_score +
      0.2 * (100 - m.dispute_rate * 100),
  );

  const rationale = buildRationale(m, stake_multiplier, dispute_penalty, accuracy_multiplier);
  rationale.push(`category ${agent.service_type} risk weight x${category_multiplier.toFixed(2)}`);

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
    rationale,
  };
};

/**
 * Policy v2 — the upgrade. Rewards proven job throughput (revenue velocity) and
 * is gentler on stake while harsher on disputes. Demonstrates that risk policy
 * can be hot-swapped on Casper without touching the pool or registry contracts.
 */
export const policyV2: PolicyFn = (agent, now) => {
  const m = normalizeMetrics(agent);
  const revenue = last30DayRevenue(agent.x402_revenue_history, now);
  // v2 base uses 0.35 of revenue and adds a small throughput bonus.
  const base_limit = scaleMotes(revenue, 0.35);

  const stake_multiplier = Math.min(1.6, 1 + m.stake_cspr / 150);

  // Harsher dispute penalty (x8 instead of x5).
  const dispute_penalty = Math.max(0.15, 1 - m.dispute_rate * 8);
  const accuracy_multiplier = m.accuracy_score / 100;

  // Throughput bonus: more completed jobs => slightly higher line, capped.
  const throughput_bonus = Math.min(1.25, 1 + m.total_jobs_completed / 1000);

  const category_multiplier = categoryRiskMultiplier(agent.service_type);
  const ratio = stake_multiplier * dispute_penalty * accuracy_multiplier * throughput_bonus * category_multiplier;
  const credit_line = clampMotes(scaleMotes(base_limit, ratio));

  const credit_score = clampScore(
    0.45 * m.accuracy_score +
      0.25 * m.reputation_score +
      0.2 * (100 - m.dispute_rate * 100) +
      0.1 * Math.min(100, m.total_jobs_completed / 5),
  );

  const rationale = buildRationale(m, stake_multiplier, dispute_penalty, accuracy_multiplier);
  rationale.push(`throughput bonus x${throughput_bonus.toFixed(2)} (${m.total_jobs_completed} jobs)`);
  rationale.push(`category ${agent.service_type} risk weight x${category_multiplier.toFixed(2)}`);

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

/** A credit line is never negative; defends against any inverted ratio. */
function clampMotes(motes: bigint): bigint {
  return motes > 0n ? motes : 0n;
}

/** Higher score => cheaper credit. Ranges ~8% APR (great) to ~22% APR (weak). */
function interestFromScore(score: number): number {
  const apr = 0.22 - (score / 100) * 0.14; // 0.22 down to 0.08
  return Math.round(apr * 10_000); // bps
}

function buildRationale(
  m: NormalizedMetrics,
  stake_multiplier: number,
  dispute_penalty: number,
  accuracy_multiplier: number,
): string[] {
  const r: string[] = [];
  r.push(`30-day x402 revenue underpins the base limit`);
  r.push(`stake multiplier x${stake_multiplier.toFixed(2)} (staked collateral)`);
  if (m.dispute_rate <= 0.03) r.push(`low dispute rate (${(m.dispute_rate * 100).toFixed(1)}%)`);
  else r.push(`dispute penalty x${dispute_penalty.toFixed(2)} (${(m.dispute_rate * 100).toFixed(1)}% disputes)`);
  r.push(`evidence accuracy ${m.accuracy_score}/100 (x${accuracy_multiplier.toFixed(2)})`);
  return r;
}
