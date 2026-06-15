import type { Ledger } from "../lib/ledger/index.js";
import { formatCspr } from "../lib/core/units.js";

export interface RoutingAction {
  utilization: number; // 0..1
  recommendation: "deploy_idle" | "build_buffer" | "hold";
  note: string;
}

/**
 * LiquidityRouterAgent (p2 §8.1, optional) — monitors pool utilization and
 * recommends routing idle liquidity vs. building treasury buffers. In production
 * this would call the CSPR.trade MCP to rebalance CSPR / staked-CSPR exposure.
 */
export class LiquidityRouterAgent {
  constructor(
    private readonly ledger: Ledger,
    private readonly targetUtilization = 0.6,
  ) {}

  evaluate(): RoutingAction {
    const pool = this.ledger.pool.poolState();
    const liq = Number(pool.total_liquidity);
    const utilization = liq > 0 ? Number(pool.outstanding_credit) / liq : 0;

    if (utilization < this.targetUtilization - 0.15) {
      return {
        utilization,
        recommendation: "deploy_idle",
        note: `utilization ${(utilization * 100).toFixed(0)}% below target — ${formatCspr(
          pool.total_liquidity - pool.outstanding_credit,
        )} CSPR idle; widen credit lines or route to staking.`,
      };
    }
    if (utilization > this.targetUtilization + 0.2) {
      return {
        utilization,
        recommendation: "build_buffer",
        note: `utilization ${(utilization * 100).toFixed(0)}% high — build buffer / attract LP deposits.`,
      };
    }
    return { utilization, recommendation: "hold", note: `utilization ${(utilization * 100).toFixed(0)}% near target.` };
  }
}
