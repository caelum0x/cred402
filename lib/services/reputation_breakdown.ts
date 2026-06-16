import type { Ledger } from "../ledger/ledger.js";

/**
 * Reputation breakdown — what actually drives an agent's composite reputation. The
 * score is a weighted blend of quality, timeliness, dispute record, revenue,
 * repayment history and category expertise, minus a collusion penalty. Showing the
 * per-dimension value, weight and contribution turns an opaque number into
 * actionable feedback: an agent can see exactly which lever to pull.
 */

const WEIGHTS: Record<string, number> = {
  quality_score: 0.3,
  timeliness_score: 0.1,
  dispute_score: 0.2,
  revenue_score: 0.15,
  repayment_score: 0.15,
  category_expertise_score: 0.1,
};

export interface ReputationDimension {
  dimension: string;
  value: number; // 0..100
  weight: number; // 0..1 (0 for the penalty term)
  contribution: number; // value × weight (or negative for the penalty)
}

export interface ReputationBreakdown {
  agent_id: string;
  composite_score: number; // recomputed weighted score
  stored_reputation: number; // the agent's current on-chain reputation
  dimensions: ReputationDimension[];
}

export function buildReputationBreakdown(ledger: Ledger, agentId: string): ReputationBreakdown | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const openDisputes = ledger.disputes.openCount(agentId);
  const repaymentEvents = ledger.bus.all().filter((e) => e.name === "CreditRepaid" && (e.data as { agent_id?: string }).agent_id === agentId);
  const { dimensions, score } = ledger.reputation.compute(agent, {
    open_disputes: openDisputes,
    repayments_on_time: repaymentEvents.length,
    repayments_total: repaymentEvents.length,
  });

  const rows: ReputationDimension[] = (Object.keys(dimensions) as Array<keyof typeof dimensions>).map((key) => {
    const value = dimensions[key] as number;
    if (key === "collusion_penalty") {
      return { dimension: key, value, weight: 0, contribution: -value };
    }
    const weight = WEIGHTS[key] ?? 0;
    return { dimension: key, value, weight, contribution: Math.round(value * weight * 100) / 100 };
  });

  return {
    agent_id: agentId,
    composite_score: score,
    stored_reputation: agent.reputation_score,
    dimensions: rows.sort((a, b) => b.contribution - a.contribution),
  };
}
