import type { Ledger } from "../ledger/ledger.js";
import type { AttestationGraph } from "./attestation_graph.js";
import { discoverAgents } from "./discovery.js";
import { FraudService } from "./fraud_service.js";

/**
 * Agent comparison — a buyer deciding between two agents wants them side by side on
 * the signals that matter, plus a clear "who's stronger" verdict. This composes the
 * discovery score and the underlying metrics for two agents and picks a winner per
 * dimension (and overall, by discovery score), so a counterparty can choose quickly.
 */

export interface ComparedMetric {
  metric: string;
  a: number;
  b: number;
  winner: "a" | "b" | "tie";
  higher_is_better: boolean;
}

export interface AgentComparison {
  a: string;
  b: string;
  metrics: ComparedMetric[];
  overall_winner: "a" | "b" | "tie";
  summary: string;
}

export function compareAgents(
  ledger: Ledger,
  attestations: AttestationGraph,
  idA: string,
  idB: string,
): AgentComparison | { error: string } {
  const agentA = ledger.agents.get(idA);
  const agentB = ledger.agents.get(idB);
  if (!agentA) return { error: `unknown agent: ${idA}` };
  if (!agentB) return { error: `unknown agent: ${idB}` };

  const fraud = new FraudService(ledger);
  // Reuse discovery for the composite score (limit covers the full roster).
  const ranked = discoverAgents(ledger, attestations, { limit: 200 }).results;
  const scoreOf = (id: string) => ranked.find((r) => r.agent_id === id)?.score ?? 0;
  const revenueOf = (a: typeof agentA) => Number(a.x402_revenue_history.reduce((s, e) => s + e.amount, 0n));

  const compare = (metric: string, a: number, b: number, higher: boolean): ComparedMetric => ({
    metric,
    a,
    b,
    higher_is_better: higher,
    winner: a === b ? "tie" : (higher ? a > b : a < b) ? "a" : "b",
  });

  const metrics: ComparedMetric[] = [
    compare("discovery_score", scoreOf(idA), scoreOf(idB), true),
    compare("reputation", agentA.reputation_score, agentB.reputation_score, true),
    compare("credit_score", agentA.credit_score, agentB.credit_score, true),
    compare("trust_score", attestations.forAgent(idA).trust_score, attestations.forAgent(idB).trust_score, true),
    compare("revenue_motes", revenueOf(agentA), revenueOf(agentB), true),
    compare("fraud_score", fraud.analyze(idA).score, fraud.analyze(idB).score, false),
    compare("dispute_rate", agentA.dispute_rate, agentB.dispute_rate, false),
  ];

  const sA = scoreOf(idA);
  const sB = scoreOf(idB);
  const overall_winner: AgentComparison["overall_winner"] = sA === sB ? "tie" : sA > sB ? "a" : "b";
  const winnerId = overall_winner === "a" ? idA : overall_winner === "b" ? idB : null;
  const summary =
    winnerId === null
      ? `${idA} and ${idB} are evenly matched (discovery score ${sA}).`
      : `${winnerId} is the stronger counterparty (discovery score ${Math.max(sA, sB)} vs ${Math.min(sA, sB)}).`;

  return { a: idA, b: idB, metrics, overall_winner, summary };
}
