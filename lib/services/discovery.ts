import type { Ledger } from "../ledger/ledger.js";
import type { AttestationGraph } from "./attestation_graph.js";
import { FraudService } from "./fraud_service.js";
import { computeTier } from "./reputation_tiers.js";

/**
 * Agent discovery — the buyer-facing search surface. A counterparty (human or
 * agent) looking to delegate RWA work needs more than a name: it needs a single,
 * defensible ranking that fuses on-chain reputation, creditworthiness, web-of-trust
 * standing, realized revenue, and a fraud penalty. This composes those signals into
 * one discovery score and ranks agents, optionally filtered by service type.
 */

const TIER_BONUS: Record<string, number> = {
  diamond: 12,
  platinum: 9,
  gold: 6,
  silver: 3,
  bronze: 1,
  unrated: 0,
};

export interface DiscoveryRow {
  rank: number;
  agent_id: string;
  service_type: string;
  score: number; // 0..100 composite
  reputation: number;
  credit_score: number;
  tier: string;
  trust_score: number;
  vouches: number;
  revenue_motes: string;
  fraud_score: number;
  recommended: boolean;
}

export interface DiscoveryQuery {
  service_type?: string;
  min_reputation?: number;
  min_score?: number;
  limit?: number;
}

export interface DiscoveryResult {
  query: DiscoveryQuery;
  count: number;
  results: DiscoveryRow[];
}

/** Compose the discovery score from the agent's signals. Deterministic, 0..100. */
function discoveryScore(input: {
  reputation: number;
  credit_score: number;
  trust_score: number;
  tier: string;
  fraud_score: number;
}): number {
  const trustComponent = Math.min(100, input.trust_score * 16); // ~6 vouches saturates
  const raw =
    0.35 * input.reputation +
    0.25 * input.credit_score +
    0.2 * trustComponent +
    (TIER_BONUS[input.tier] ?? 0) -
    0.4 * input.fraud_score;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export function discoverAgents(
  ledger: Ledger,
  attestations: AttestationGraph,
  query: DiscoveryQuery = {},
): DiscoveryResult {
  const fraud = new FraudService(ledger);
  const minRep = query.min_reputation ?? 0;
  const minScore = query.min_score ?? 0;
  const limit = Math.max(1, Math.min(query.limit ?? 50, 200));
  const wantService = query.service_type?.trim().toLowerCase();

  const rows = ledger.agents
    .list()
    .filter((a) => (wantService ? a.service_type.toLowerCase() === wantService : true))
    .filter((a) => a.reputation_score >= minRep)
    .map((a) => {
      const t = computeTier(ledger, a.agent_id);
      const tier = "tier" in t ? t.tier : "unrated";
      const { trust_score, received } = attestations.forAgent(a.agent_id);
      const fraud_score = fraud.analyze(a.agent_id).score;
      const score = discoveryScore({
        reputation: a.reputation_score,
        credit_score: a.credit_score,
        trust_score,
        tier,
        fraud_score,
      });
      const revenue_motes = a.x402_revenue_history.reduce((s, e) => s + e.amount, 0n).toString();
      return {
        agent_id: a.agent_id,
        service_type: a.service_type,
        score,
        reputation: a.reputation_score,
        credit_score: a.credit_score,
        tier,
        trust_score,
        vouches: received.length,
        revenue_motes,
        fraud_score,
        recommended: score >= 70 && fraud_score < 30,
      };
    })
    .filter((r) => r.score >= minScore)
    .sort((x, y) => y.score - x.score || (BigInt(y.revenue_motes) > BigInt(x.revenue_motes) ? 1 : -1))
    .slice(0, limit)
    .map((r, i) => ({ rank: i + 1, ...r }));

  return { query, count: rows.length, results: rows };
}
