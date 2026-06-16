import type { Ledger } from "../ledger/ledger.js";
import type { AttestationGraph } from "./attestation_graph.js";
import { buildAgentHealthBadge } from "./agent_health.js";
import { buildPeerBenchmark } from "./peer_benchmark.js";
import { buildOnboardingScorecard } from "./onboarding_scorecard.js";
import { buildScoreTrend } from "./score_trend.js";
import { computeTier } from "./reputation_tiers.js";

/**
 * Agent dossier — the integrator's one-call snapshot. Dashboards otherwise fan out
 * 6+ requests per agent (passport, tier, health, benchmark, readiness, line); this
 * bundles the bureau-level view into a single `/v1` round-trip. Each section reuses
 * the same canonical services as its standalone endpoint, so the dossier never
 * drifts from the individual reads.
 */

export interface AgentDossier {
  agent_id: string;
  service_type: string;
  reputation: number;
  credit_score: number;
  tier: string;
  health: { status: string; score: number };
  readiness: { ready: boolean; readiness_pct: number };
  benchmark: { cohort_size: number; overall_percentile: number };
  reputation_change: number; // net, from the score trend
  credit_line: { max_credit_motes: string; drawn_motes: string; status: string } | null;
  operator: string | null;
}

export function buildAgentDossier(
  ledger: Ledger,
  attestations: AttestationGraph,
  agentId: string,
): AgentDossier | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const tier = computeTier(ledger, agentId);
  const health = buildAgentHealthBadge(ledger, agentId);
  const readiness = buildOnboardingScorecard(ledger, agentId);
  const benchmark = buildPeerBenchmark(ledger, agentId);
  const trend = buildScoreTrend(ledger, agentId);
  const line = ledger.pool.get(agentId);

  return {
    agent_id: agentId,
    service_type: agent.service_type,
    reputation: agent.reputation_score,
    credit_score: agent.credit_score,
    tier: "tier" in tier ? tier.tier : "unrated",
    health: "error" in health ? { status: "unknown", score: 0 } : { status: health.status, score: health.score },
    readiness: "error" in readiness ? { ready: false, readiness_pct: 0 } : { ready: readiness.ready, readiness_pct: readiness.readiness_pct },
    benchmark: "error" in benchmark ? { cohort_size: 0, overall_percentile: 0 } : { cohort_size: benchmark.cohort_size, overall_percentile: benchmark.overall_percentile },
    reputation_change: "error" in trend ? 0 : trend.reputation.change,
    credit_line: line ? { max_credit_motes: line.max_credit.toString(), drawn_motes: line.drawn.toString(), status: line.status } : null,
    operator: ledger.buildPassport(agentId)?.operator ?? null,
  };
}
