import type { Ledger } from "../ledger/ledger.js";

/**
 * Reputation movers — "who's rising and who's falling". A point-in-time leaderboard
 * hides momentum; a counterparty wants to see trajectory. This reconstructs each
 * agent's net reputation change from the canonical event log (ReputationUpdated)
 * and surfaces the biggest gainers and losers, so trend — not just level — is
 * visible.
 */

export interface Mover {
  agent_id: string;
  change: number; // net reputation delta over the observed window
  current: number;
  events: number; // number of reputation updates observed
}

export interface ReputationMovers {
  generated_at: number;
  gainers: Mover[];
  losers: Mover[];
}

export function buildReputationMovers(ledger: Ledger, limit = 5): ReputationMovers {
  // Walk the log once, tracking first/last observed reputation per agent.
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const e of ledger.bus.all()) {
    if (e.name !== "ReputationUpdated") continue;
    const id = e.data.agent_id;
    const value = Number(e.data.current ?? e.data.new_score);
    if (typeof id !== "string" || !Number.isFinite(value)) continue;
    if (!first.has(id)) first.set(id, Number(e.data.previous ?? value));
    last.set(id, value);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const movers: Mover[] = [...last.keys()].map((id) => ({
    agent_id: id,
    change: (last.get(id) ?? 0) - (first.get(id) ?? 0),
    current: ledger.agents.get(id)?.reputation_score ?? last.get(id) ?? 0,
    events: counts.get(id) ?? 0,
  }));

  const cap = Math.max(1, Math.min(limit, 50));
  const gainers = movers
    .filter((m) => m.change > 0)
    .sort((a, b) => b.change - a.change)
    .slice(0, cap);
  const losers = movers
    .filter((m) => m.change < 0)
    .sort((a, b) => a.change - b.change)
    .slice(0, cap);

  return { generated_at: ledger.clock.now(), gainers, losers };
}
