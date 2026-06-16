import type { Ledger } from "../ledger/ledger.js";
import { FraudService } from "./fraud_service.js";

/**
 * Agent health badge — one glanceable verdict (green / amber / red) for an agent's
 * overall standing, distinct from the credit-readiness checklist. Readiness answers
 * "can it borrow?"; the health badge answers "is this counterparty healthy right
 * now?" by fusing reputation, fraud risk, open disputes, and any credit-line health
 * into a single traffic light plus the factors that drove it.
 */

export type HealthStatus = "green" | "amber" | "red";

export interface HealthFactor {
  label: string;
  status: HealthStatus;
  detail: string;
}

export interface AgentHealthBadge {
  agent_id: string;
  status: HealthStatus; // worst-of the factors
  score: number; // 0..100 composite
  factors: HealthFactor[];
}

const RANK: Record<HealthStatus, number> = { green: 0, amber: 1, red: 2 };
function worst(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

export function buildAgentHealthBadge(ledger: Ledger, agentId: string): AgentHealthBadge | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const fraud = new FraudService(ledger).analyze(agentId);
  const openDisputes = ledger.disputes.openCount(agentId);
  const line = ledger.pool.get(agentId);

  const factors: HealthFactor[] = [];

  // Reputation.
  factors.push({
    label: "reputation",
    status: agent.reputation_score >= 70 ? "green" : agent.reputation_score >= 40 ? "amber" : "red",
    detail: `${agent.reputation_score}/100`,
  });

  // Fraud risk.
  factors.push({
    label: "fraud risk",
    status: fraud.score < 30 ? "green" : fraud.score < 70 ? "amber" : "red",
    detail: `score ${fraud.score}${fraud.flags.length ? ` (${fraud.flags.map((f) => f.code).join(", ")})` : ""}`,
  });

  // Open disputes.
  factors.push({
    label: "disputes",
    status: openDisputes === 0 ? "green" : "red",
    detail: openDisputes === 0 ? "none open" : `${openDisputes} open`,
  });

  // Credit-line health (only if a line exists).
  if (line) {
    const overdue = line.drawn > 0n && line.due_timestamp < ledger.clock.now();
    const status: HealthStatus =
      line.status === "defaulted" || overdue ? "red" : line.status === "frozen" ? "amber" : "green";
    factors.push({
      label: "credit line",
      status,
      detail: overdue ? "overdue" : line.status,
    });
  }

  const status = factors.reduce<HealthStatus>((acc, f) => worst(acc, f.status), "green");
  // Score: start at reputation, subtract fraud, penalize red/amber factors.
  const penalty = factors.filter((f) => f.status === "red").length * 25 + factors.filter((f) => f.status === "amber").length * 10;
  const score = Math.max(0, Math.min(100, Math.round(agent.reputation_score - fraud.score * 0.3 - penalty)));

  return { agent_id: agentId, status, score, factors };
}
