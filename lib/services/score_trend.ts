import type { Ledger } from "../ledger/ledger.js";

/**
 * Credit-score & reputation trend — a credit bureau is judged on its time series,
 * not just a point score. This reconstructs an agent's credit-score and reputation
 * trajectory from the canonical event log (CreditScoreSet / ReputationUpdated), so
 * counterparties can see direction and volatility, not only the latest number.
 */

export interface TrendPoint {
  seq: number;
  timestamp: number;
  value: number;
}

export interface ScoreTrend {
  agent_id: string;
  credit_score: { current: number; change: number; points: TrendPoint[] };
  reputation: { current: number; change: number; points: TrendPoint[] };
}

function changeOf(points: TrendPoint[]): number {
  if (points.length < 2) return 0;
  return points[points.length - 1]!.value - points[0]!.value;
}

export function buildScoreTrend(ledger: Ledger, agentId: string): ScoreTrend | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const creditPoints: TrendPoint[] = [];
  const repPoints: TrendPoint[] = [];
  for (const e of ledger.bus.all()) {
    if (e.name === "CreditScoreSet" && e.data.agent_id === agentId) {
      const value = Number(e.data.credit_score);
      if (Number.isFinite(value)) creditPoints.push({ seq: e.seq, timestamp: e.timestamp, value });
    } else if (e.name === "ReputationUpdated" && e.data.agent_id === agentId) {
      const value = Number(e.data.current ?? e.data.new_score);
      if (Number.isFinite(value)) repPoints.push({ seq: e.seq, timestamp: e.timestamp, value });
    }
  }

  return {
    agent_id: agentId,
    credit_score: { current: agent.credit_score, change: changeOf(creditPoints), points: creditPoints },
    reputation: { current: agent.reputation_score, change: changeOf(repPoints), points: repPoints },
  };
}
