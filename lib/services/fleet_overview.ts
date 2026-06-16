import type { Ledger } from "../ledger/ledger.js";
import type { AttestationGraph } from "./attestation_graph.js";
import { discoverAgents } from "./discovery.js";
import { buildOnboardingScorecard } from "./onboarding_scorecard.js";

/**
 * Fleet overview — for an operator running many agents, a one-call dashboard that
 * joins each agent's discovery standing with its credit readiness and current line.
 * Unknown ids are surfaced rather than dropped so the caller can reconcile its list.
 */

export interface FleetAgentRow {
  agent_id: string;
  exists: boolean;
  service_type?: string;
  reputation?: number;
  credit_score?: number;
  discovery_score?: number;
  tier?: string;
  ready?: boolean;
  readiness_pct?: number;
  has_credit_line?: boolean;
  drawn_motes?: string;
}

export interface FleetOverview {
  count: number;
  ready: number;
  not_ready: number;
  unknown: number;
  agents: FleetAgentRow[];
}

export function buildFleetOverview(ledger: Ledger, attestations: AttestationGraph, agentIds: string[]): FleetOverview {
  const discovery = discoverAgents(ledger, attestations, { limit: 200 });
  const rankByAgent = new Map(discovery.results.map((r) => [r.agent_id, r]));

  const agents: FleetAgentRow[] = agentIds.map((id) => {
    const agent = ledger.agents.get(id);
    if (!agent) return { agent_id: id, exists: false };
    const readiness = buildOnboardingScorecard(ledger, id);
    const rank = rankByAgent.get(id);
    const line = ledger.pool.get(id);
    return {
      agent_id: id,
      exists: true,
      service_type: agent.service_type,
      reputation: agent.reputation_score,
      credit_score: agent.credit_score,
      discovery_score: rank?.score ?? 0,
      tier: rank?.tier ?? "unrated",
      ready: "error" in readiness ? false : readiness.ready,
      readiness_pct: "error" in readiness ? 0 : readiness.readiness_pct,
      has_credit_line: line !== undefined,
      drawn_motes: line ? line.drawn.toString() : "0",
    };
  });

  const existing = agents.filter((r) => r.exists);
  const ready = existing.filter((r) => r.ready).length;
  return {
    count: agents.length,
    ready,
    not_ready: existing.length - ready,
    unknown: agents.length - existing.length,
    agents,
  };
}
