import type { Ledger } from "../ledger/ledger.js";
import { categoryFamily } from "../core/service_categories.js";

/**
 * Mainnet-beta market risk + launch controls (roadmap p4).
 *
 * Turns the credit pool into something safe to launch with real value: per-agent
 * and per-category exposure caps, a pool-utilization ceiling, an approved-category
 * allowlist for the beta, and insurance-reserve loss absorption on default. Every
 * draw is gated; every default loss is covered from the reserve first, with honest
 * reporting of any uncovered shortfall.
 */
export interface MainnetBetaConfig {
  /** Only these service categories may draw during the beta ([] = allow all). */
  approved_categories: string[];
  /** Hard cap on any single agent's outstanding credit (motes). */
  max_agent_exposure_motes: bigint;
  /** Per-category cap as bps of total pool liquidity (e.g. 2500 = 25%). */
  max_category_exposure_bps: number;
  /** Pool utilization ceiling as bps of liquidity (e.g. 8000 = 80%). */
  max_pool_utilization_bps: number;
}

export const DEFAULT_BETA_CONFIG: MainnetBetaConfig = {
  approved_categories: [], // allow all categories by default; tighten for beta
  max_agent_exposure_motes: 500n * 1_000_000_000n, // 500 CSPR
  max_category_exposure_bps: 3000, // 30% of the pool per category
  max_pool_utilization_bps: 8000, // 80% utilization ceiling
};

export interface DrawCheck {
  allowed: boolean;
  reason?: string;
  agent_exposure_motes: string;
  category_exposure_motes: string;
  pool_utilization_bps: number;
}

export interface DefaultCoverage {
  loss_motes: string;
  covered_motes: string;
  uncovered_motes: string;
  reserve_after_motes: string;
}

export class MarketRiskManager {
  private readonly cfg: MainnetBetaConfig;
  constructor(
    private readonly ledger: Ledger,
    cfg: Partial<MainnetBetaConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_BETA_CONFIG, ...cfg };
  }

  private familyExposure(family: string): bigint {
    return this.ledger.pool
      .list()
      .filter((l) => {
        const a = this.ledger.agents.get(l.agent_id);
        return a ? categoryFamily(a.service_type) === family : false;
      })
      .reduce((sum, l) => sum + l.drawn, 0n);
  }

  /** Gate a prospective draw against all beta risk caps. */
  checkDraw(agentId: string, amount: bigint): DrawCheck {
    const pool = this.ledger.pool.poolState();
    const agent = this.ledger.agents.get(agentId);
    const line = this.ledger.pool.get(agentId);
    const agentExposure = (line?.drawn ?? 0n) + amount;
    const family = agent ? categoryFamily(agent.service_type) : "unknown";
    const categoryExposure = this.familyExposure(family) + amount;
    const outstandingAfter = pool.outstanding_credit + amount;
    const utilBps = pool.total_liquidity > 0n ? Number((outstandingAfter * 10000n) / pool.total_liquidity) : 10000;

    const base: Omit<DrawCheck, "allowed" | "reason"> = {
      agent_exposure_motes: agentExposure.toString(),
      category_exposure_motes: categoryExposure.toString(),
      pool_utilization_bps: utilBps,
    };

    if (!agent) return { allowed: false, reason: "unknown agent", ...base };
    if (this.cfg.approved_categories.length > 0 && !this.cfg.approved_categories.includes(family)) {
      return { allowed: false, reason: `category ${family} not approved for beta`, ...base };
    }
    if (agentExposure > this.cfg.max_agent_exposure_motes) {
      return { allowed: false, reason: "exceeds per-agent exposure cap", ...base };
    }
    if (pool.total_liquidity > 0n && categoryExposure * 10000n > pool.total_liquidity * BigInt(this.cfg.max_category_exposure_bps)) {
      return { allowed: false, reason: `exceeds per-category cap (${this.cfg.max_category_exposure_bps / 100}% of pool)`, ...base };
    }
    if (utilBps > this.cfg.max_pool_utilization_bps) {
      return { allowed: false, reason: `exceeds pool utilization ceiling (${this.cfg.max_pool_utilization_bps / 100}%)`, ...base };
    }
    return { allowed: true, ...base };
  }

  /** Absorb a default loss from the insurance reserve first; report any shortfall. */
  coverDefault(agentId: string, lossMotes: bigint): DefaultCoverage {
    const reserve = BigInt(this.ledger.slashing.reserveBalances().insurance_reserve);
    const covered = lossMotes <= reserve ? lossMotes : reserve;
    if (covered > 0n) this.ledger.slashing.claim_insurance(agentId, covered, "credit_default_coverage");
    const reserveAfter = BigInt(this.ledger.slashing.reserveBalances().insurance_reserve);
    return {
      loss_motes: lossMotes.toString(),
      covered_motes: covered.toString(),
      uncovered_motes: (lossMotes - covered).toString(),
      reserve_after_motes: reserveAfter.toString(),
    };
  }

  /** Reserve coverage of outstanding credit, in bps (higher = safer). */
  coverageRatioBps(): number {
    const pool = this.ledger.pool.poolState();
    if (pool.outstanding_credit === 0n) return 10000;
    const reserve = BigInt(this.ledger.slashing.reserveBalances().insurance_reserve);
    return Number((reserve * 10000n) / pool.outstanding_credit);
  }
}
