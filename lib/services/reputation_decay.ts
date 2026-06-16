import type { Ledger } from "../ledger/ledger.js";

/**
 * Reputation time-decay (p2 §6.6).
 *
 * Reputation is not permanent: an inactive agent drifts back toward a neutral
 * floor, so credit reflects RECENT proven work. Decay is driven by days since the
 * agent's last finalized receipt, past a grace period, at a configurable rate,
 * never below the floor. Run periodically; returns what changed.
 */

export interface DecayResult {
  applied: Array<{ agent_id: string; from: number; to: number; inactive_days: number }>;
  floor: number;
}

export interface DecayOptions {
  floor?: number; // reputation never decays below this
  graceDays?: number; // no decay within this many days of last activity
  pointsPerDay?: number; // decay rate beyond the grace period
  /** Override the elapsed-inactivity calculation (for projection/testing). */
  assumeInactiveDays?: number;
}

const DAY = 24 * 60 * 60;

export function applyReputationDecay(ledger: Ledger, opts: DecayOptions = {}): DecayResult {
  const floor = opts.floor ?? 50;
  const graceDays = opts.graceDays ?? 7;
  const pointsPerDay = opts.pointsPerDay ?? 2;
  const now = ledger.clock.now();
  const applied: DecayResult["applied"] = [];

  for (const agent of ledger.agents.list()) {
    if (agent.reputation_score <= floor) continue;
    const receipts = ledger.receipts.forSeller(agent.agent_id);
    const lastActivity = receipts.length ? Math.max(...receipts.map((r) => r.timestamp)) : agent.registered_at;
    const inactiveDays = opts.assumeInactiveDays ?? Math.max(0, (now - lastActivity) / DAY);
    if (inactiveDays <= graceDays) continue;

    const rawDecay = Math.floor((inactiveDays - graceDays) * pointsPerDay);
    const decay = Math.min(rawDecay, agent.reputation_score - floor);
    if (decay <= 0) continue;

    const from = agent.reputation_score;
    ledger.agents.update_reputation(agent.agent_id, -decay, "0xdecay", "REPUTATION_DECAY");
    applied.push({ agent_id: agent.agent_id, from, to: from - decay, inactive_days: Math.round(inactiveDays * 10) / 10 });
  }

  return { applied, floor };
}
