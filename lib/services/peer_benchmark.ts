import type { Ledger } from "../ledger/ledger.js";
import { FraudService } from "./fraud_service.js";

/**
 * Peer benchmark — answers "how does this agent compare to its peers?". For a
 * credit bureau this is the context that turns a raw score into a decision: a 70
 * reputation means little until you know whether peers sit at 50 or 90. We compute
 * the agent's percentile within its service-type cohort across the signals that
 * drive credit, plus the cohort medians.
 */

export interface MetricBenchmark {
  value: number;
  cohort_median: number;
  percentile: number; // 0..100 — share of peers this agent is >= to
  rank: number; // 1 = best in cohort
}

export interface PeerBenchmark {
  agent_id: string;
  service_type: string;
  cohort_size: number;
  reputation: MetricBenchmark;
  credit_score: MetricBenchmark;
  revenue: MetricBenchmark; // motes, as number for percentile math
  fraud_score: MetricBenchmark; // lower is better — percentile inverts
  overall_percentile: number; // average of the favorable percentiles
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

/** Percentile of `value` within `all` (share of cohort at or below it), 0..100.
 * For "higher is better" metrics this rewards larger values; pass invert=true for
 * metrics where lower is better (fraud). */
function percentileOf(value: number, all: number[], invert = false): number {
  if (all.length <= 1) return 100;
  const atOrBelow = all.filter((x) => (invert ? x >= value : x <= value)).length;
  return Math.round((atOrBelow / all.length) * 100);
}

function rankOf(value: number, all: number[], invert = false): number {
  // 1 = best. Higher value ranks first unless invert (lower is better).
  const sorted = [...all].sort((a, b) => (invert ? a - b : b - a));
  return sorted.indexOf(value) + 1;
}

export function buildPeerBenchmark(ledger: Ledger, agentId: string): PeerBenchmark | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const fraud = new FraudService(ledger);
  const cohort = ledger.agents.list().filter((a) => a.service_type === agent.service_type);
  const revenueOf = (id: string) => {
    const a = ledger.agents.get(id);
    return a ? Number(a.x402_revenue_history.reduce((s, e) => s + e.amount, 0n)) : 0;
  };

  const reps = cohort.map((a) => a.reputation_score);
  const scores = cohort.map((a) => a.credit_score);
  const revenues = cohort.map((a) => revenueOf(a.agent_id));
  const frauds = cohort.map((a) => fraud.analyze(a.agent_id).score);

  const myRep = agent.reputation_score;
  const myScore = agent.credit_score;
  const myRevenue = revenueOf(agentId);
  const myFraud = fraud.analyze(agentId).score;

  const benchmark = (value: number, all: number[], invert = false): MetricBenchmark => ({
    value,
    cohort_median: median(all),
    percentile: percentileOf(value, all, invert),
    rank: rankOf(value, all, invert),
  });

  const reputation = benchmark(myRep, reps);
  const credit_score = benchmark(myScore, scores);
  const revenue = benchmark(myRevenue, revenues);
  const fraud_score = benchmark(myFraud, frauds, true);
  const overall_percentile = Math.round(
    (reputation.percentile + credit_score.percentile + revenue.percentile + fraud_score.percentile) / 4,
  );

  return {
    agent_id: agentId,
    service_type: agent.service_type,
    cohort_size: cohort.length,
    reputation,
    credit_score,
    revenue,
    fraud_score,
    overall_percentile,
  };
}
