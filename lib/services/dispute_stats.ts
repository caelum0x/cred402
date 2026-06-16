import type { Ledger } from "../ledger/ledger.js";

/**
 * Dispute statistics — protocol-level intelligence on the dispute system's health.
 * A credit market lives or dies on whether its dispute process is fair and active:
 * how many disputes, how they resolve, how much stake is slashed, and which
 * categories recur. This aggregates the DisputeCourt + SlashingVault into a single
 * read, complementing the per-agent dispute view.
 */

export interface DisputeStats {
  generated_at: number;
  total: number;
  open: number;
  resolved: number;
  by_verdict: Record<string, number>;
  by_type: Record<string, number>;
  total_slashed_motes: string;
  resolution_rate: number; // resolved / total, 0..1
  agent_loss_rate: number; // agent_loses / resolved, 0..1
  most_disputed_agent: { agent_id: string; disputes: number } | null;
}

export function buildDisputeStats(ledger: Ledger): DisputeStats {
  const disputes = ledger.disputes.list();
  const byVerdict: Record<string, number> = {};
  const byType: Record<string, number> = {};
  const byAgent = new Map<string, number>();
  let open = 0;
  let resolved = 0;

  for (const d of disputes) {
    byType[d.dispute_type] = (byType[d.dispute_type] ?? 0) + 1;
    byAgent.set(d.respondent_agent, (byAgent.get(d.respondent_agent) ?? 0) + 1);
    if (d.status === "resolved" || d.status === "closed") {
      resolved++;
      if (d.verdict) byVerdict[d.verdict] = (byVerdict[d.verdict] ?? 0) + 1;
    } else {
      open++;
    }
  }

  let mostDisputed: { agent_id: string; disputes: number } | null = null;
  for (const [agent_id, count] of byAgent) {
    if (!mostDisputed || count > mostDisputed.disputes) mostDisputed = { agent_id, disputes: count };
  }

  const agentLosses = byVerdict["agent_loses"] ?? 0;
  return {
    generated_at: ledger.clock.now(),
    total: disputes.length,
    open,
    resolved,
    by_verdict: byVerdict,
    by_type: byType,
    total_slashed_motes: ledger.slashing.totalSlashed().toString(),
    resolution_rate: disputes.length ? Math.round((resolved / disputes.length) * 100) / 100 : 0,
    agent_loss_rate: resolved ? Math.round((agentLosses / resolved) * 100) / 100 : 0,
    most_disputed_agent: mostDisputed,
  };
}
