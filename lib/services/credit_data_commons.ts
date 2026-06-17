import type { Ledger } from "../ledger/ledger.js";
import { categoryFamily } from "../core/service_categories.js";
import { computeTier, TIER_ORDER } from "./reputation_tiers.js";

/**
 * Credit-data commons (roadmap p6 — data moat as a public good).
 *
 * Cred402's defensible asset is the credit-performance dataset it accumulates:
 * how agents in each service category behave, repay, and default. Hoarding it is a
 * moat; PUBLISHING an anonymized aggregate of it is a stronger one — it makes
 * Cred402 the reference credit benchmark the rest of the x402 economy cites, while
 * the per-agent raw data stays private.
 *
 * This builds a privacy-preserving public snapshot: protocol-wide and per-category
 * aggregates only, with k-anonymity (categories thinner than `kAnon` agents are
 * folded into "other" so no individual agent is re-identifiable). No agent ids,
 * ever. Safe to serve publicly and cite.
 */

export interface CategoryAggregate {
  family: string;
  agent_count: number;
  avg_reputation: number;
  total_outstanding_motes: string;
  /** Share of all outstanding credit, in bps. */
  outstanding_share_bps: number;
}

export interface TierAggregate {
  tier: string;
  agent_count: number;
  share_bps: number;
}

export interface CreditDataCommonsSnapshot {
  generated_at: number;
  /** k-anonymity threshold applied to category buckets. */
  k_anonymity: number;
  agents: { total: number; active: number };
  pool: {
    total_liquidity_motes: string;
    outstanding_credit_motes: string;
    utilization_bps: number;
  };
  disputes: { total: number; resolved: number; slash_rate_bps: number };
  by_category: CategoryAggregate[];
  by_tier: TierAggregate[];
}

interface Bucket {
  family: string;
  count: number;
  reputationSum: number;
  outstanding: bigint;
}

export class CreditDataCommons {
  constructor(
    private readonly ledger: Ledger,
    private readonly kAnon = 3,
  ) {}

  /** Build the anonymized public snapshot. */
  snapshot(): CreditDataCommonsSnapshot {
    const agents = this.ledger.agents.list();
    const pool = this.ledger.pool.poolState();
    const totalOutstanding = pool.outstanding_credit;

    // Aggregate per service-category family.
    const buckets = new Map<string, Bucket>();
    for (const a of agents) {
      const family = categoryFamily(a.service_type);
      let b = buckets.get(family);
      if (!b) {
        b = { family, count: 0, reputationSum: 0, outstanding: 0n };
        buckets.set(family, b);
      }
      b.count++;
      b.reputationSum += a.reputation_score;
      b.outstanding += this.ledger.pool.get(a.agent_id)?.drawn ?? 0n;
    }

    // k-anonymity: fold sub-threshold buckets into a single "other".
    const other: Bucket = { family: "other", count: 0, reputationSum: 0, outstanding: 0n };
    const kept: Bucket[] = [];
    for (const b of buckets.values()) {
      if (b.count >= this.kAnon) kept.push(b);
      else {
        other.count += b.count;
        other.reputationSum += b.reputationSum;
        other.outstanding += b.outstanding;
      }
    }
    if (other.count > 0) kept.push(other);

    const by_category: CategoryAggregate[] = kept
      .map((b) => ({
        family: b.family,
        agent_count: b.count,
        avg_reputation: b.count > 0 ? Math.round(b.reputationSum / b.count) : 0,
        total_outstanding_motes: b.outstanding.toString(),
        outstanding_share_bps:
          totalOutstanding > 0n ? Number((b.outstanding * 10000n) / totalOutstanding) : 0,
      }))
      .sort((a, b) => b.agent_count - a.agent_count);

    // Tier distribution (already an aggregate; no per-agent leakage).
    const tierCounts = new Map<string, number>();
    for (const a of agents) {
      const t = computeTier(this.ledger, a.agent_id);
      if ("tier" in t) tierCounts.set(t.tier, (tierCounts.get(t.tier) ?? 0) + 1);
    }
    const totalTiered = agents.length;
    const by_tier: TierAggregate[] = TIER_ORDER.map((tier) => {
      const count = tierCounts.get(tier) ?? 0;
      return {
        tier,
        agent_count: count,
        share_bps: totalTiered > 0 ? Math.round((count * 10000) / totalTiered) : 0,
      };
    }).filter((t) => t.agent_count > 0);

    const disputes = this.ledger.disputes.list();
    const resolved = disputes.filter((d) => d.status === "resolved");
    const withSlash = resolved.filter((d) => d.slash_amount > 0n).length;

    return {
      generated_at: this.ledger.clock.now(),
      k_anonymity: this.kAnon,
      agents: { total: agents.length, active: agents.filter((a) => a.active).length },
      pool: {
        total_liquidity_motes: pool.total_liquidity.toString(),
        outstanding_credit_motes: pool.outstanding_credit.toString(),
        utilization_bps:
          pool.total_liquidity > 0n
            ? Number((pool.outstanding_credit * 10000n) / pool.total_liquidity)
            : 0,
      },
      disputes: {
        total: disputes.length,
        resolved: resolved.length,
        slash_rate_bps: resolved.length > 0 ? Math.round((withSlash * 10000) / resolved.length) : 0,
      },
      by_category,
      by_tier,
    };
  }

  /** Serialize the snapshot as CSV-friendly category rows (the citable benchmark). */
  categoryBenchmarkRows(): Array<Record<string, string | number>> {
    return this.snapshot().by_category.map((c) => ({
      family: c.family,
      agent_count: c.agent_count,
      avg_reputation: c.avg_reputation,
      outstanding_share_bps: c.outstanding_share_bps,
    }));
  }
}
