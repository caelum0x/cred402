import type { Ledger } from "../ledger/ledger.js";
import type { AttestationGraph } from "./attestation_graph.js";
import { discoverAgents } from "./discovery.js";

/**
 * Similar agents — "you might also consider". Given one agent, surface comparable
 * alternatives a buyer should weigh: same service category, ranked by how close they
 * are in standing (reputation + credit) and how strong they are overall (discovery
 * score). Turns a single pick into a shortlist, which is how counterparties actually
 * de-risk a delegation.
 */

export interface SimilarAgent {
  agent_id: string;
  similarity: number; // 0..1, closeness in standing
  discovery_score: number;
  reputation: number;
  credit_score: number;
  tier: string;
}

export interface SimilarAgentsResult {
  agent_id: string;
  service_type: string;
  alternatives: SimilarAgent[];
}

export function findSimilarAgents(
  ledger: Ledger,
  attestations: AttestationGraph,
  agentId: string,
  limit = 5,
): SimilarAgentsResult | { error: string } {
  const target = ledger.agents.get(agentId);
  if (!target) return { error: `unknown agent: ${agentId}` };

  const ranked = discoverAgents(ledger, attestations, { service_type: target.service_type, limit: 200 }).results;
  const targetRow = ranked.find((r) => r.agent_id === agentId);

  // Similarity = 1 − normalized distance in (reputation, credit) space [0..100 each].
  const distance = (a: { reputation: number; credit_score: number }) => {
    const dr = (a.reputation - target.reputation_score) / 100;
    const dc = (a.credit_score - target.credit_score) / 100;
    return Math.sqrt(dr * dr + dc * dc) / Math.SQRT2; // 0..1
  };

  const alternatives: SimilarAgent[] = ranked
    .filter((r) => r.agent_id !== agentId)
    .map((r) => ({
      agent_id: r.agent_id,
      similarity: Math.round((1 - distance(r)) * 100) / 100,
      discovery_score: r.score,
      reputation: r.reputation,
      credit_score: r.credit_score,
      tier: r.tier,
    }))
    // Closest in standing first; break ties by who is the stronger pick.
    .sort((a, b) => b.similarity - a.similarity || b.discovery_score - a.discovery_score)
    .slice(0, Math.max(1, Math.min(limit, 50)));

  void targetRow;
  return { agent_id: agentId, service_type: target.service_type, alternatives };
}
