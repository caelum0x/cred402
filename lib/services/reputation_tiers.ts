import type { Ledger } from "../ledger/ledger.js";

/**
 * Agent reputation tiers — a badge system that turns the composite trust profile
 * into a tier with concrete perks. Higher tiers unlock a larger credit multiplier
 * and an origination-fee discount, giving agents a legible reason to build
 * reputation. Derived purely from on-chain signals.
 */

export type Tier = "unrated" | "bronze" | "silver" | "gold" | "platinum" | "diamond";

export interface TierInfo {
  agent_id: string;
  tier: Tier;
  score: number; // 0..100 composite that determines the tier
  credit_multiplier: number; // perk: extra credit capacity
  origination_discount_bps: number; // perk: cheaper origination
  next_tier?: Tier;
  points_to_next: number;
}

const ORDER: Tier[] = ["unrated", "bronze", "silver", "gold", "platinum", "diamond"];
export const TIER_ORDER: readonly Tier[] = ORDER;
export const TIER_THRESHOLDS: Record<Tier, number> = { unrated: 0, bronze: 40, silver: 60, gold: 75, platinum: 88, diamond: 96 };
const THRESHOLDS = TIER_THRESHOLDS;
export const TIER_PERKS: Record<Tier, { mult: number; discount: number }> = {
  unrated: { mult: 1.0, discount: 0 },
  bronze: { mult: 1.0, discount: 0 },
  silver: { mult: 1.05, discount: 5 },
  gold: { mult: 1.1, discount: 10 },
  platinum: { mult: 1.18, discount: 20 },
  diamond: { mult: 1.25, discount: 30 },
};
const PERKS = TIER_PERKS;

export function computeTier(ledger: Ledger, agentId: string): TierInfo | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const receipts = ledger.receipts.forSeller(agentId).length;
  const finalized = ledger.receipts.forSeller(agentId).filter((r) => r.status === "finalized").length;
  const disputePenalty = Math.min(20, agent.dispute_rate * 100 * 4);
  // Composite: reputation + credit + activity − dispute drag.
  const score = clamp(
    0.45 * agent.reputation_score +
      0.3 * agent.credit_score +
      0.15 * Math.min(100, receipts * 5) +
      0.1 * Math.min(100, finalized * 10) -
      disputePenalty,
  );

  let tier: Tier = "unrated";
  for (const t of ORDER) if (score >= THRESHOLDS[t]) tier = t;
  const idx = ORDER.indexOf(tier);
  const next = idx < ORDER.length - 1 ? ORDER[idx + 1] : undefined;
  const perks = PERKS[tier];

  return {
    agent_id: agentId,
    tier,
    score,
    credit_multiplier: perks.mult,
    origination_discount_bps: perks.discount,
    next_tier: next,
    points_to_next: next ? Math.max(0, THRESHOLDS[next] - score) : 0,
  };
}

export function tierLeaderboard(ledger: Ledger): TierInfo[] {
  return ledger.agents
    .list()
    .map((a) => computeTier(ledger, a.agent_id))
    .filter((t): t is TierInfo => !("error" in t))
    .sort((a, b) => b.score - a.score);
}

function clamp(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)));
}
