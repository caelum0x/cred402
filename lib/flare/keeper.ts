import type { Ledger } from "../ledger/ledger.js";
import type { FlareCreditSatellite } from "./satellite.js";
import { PositionEngine, type PositionHealth, type PositionThresholds } from "./positions.js";

/**
 * Autonomous Credit Keeper — the product where both hackathons meet.
 *
 * Cred402 agents earn and borrow; their FXRP debt carries live FTSO price risk. The
 * keeper closes the loop: it CHECKS each agent's position against the FTSO oracle and,
 * when a margin call fires, autonomously EXECUTES a protective deleverage through
 * KeeperHub — preflight simulate, smart gas, private routing, audit trail. This is
 * exactly KeeperHub's `execute_check_and_execute` pattern (condition → on-chain
 * action) applied to real credit risk: nobody has to babysit a position, and every
 * automated action is observable and reversible-on-failure.
 *
 * The keeper never invents liquidity: it only ever repays (deleverages) FXRP the
 * agent already drew, so it is safe to run unattended over a whole fleet.
 */

export type KeeperActionKind = "deleverage" | "none";

export interface KeeperDecision {
  agent_id: string;
  action: KeeperActionKind;
  amount_fxrp: number;
  reason: string;
  position: PositionHealth;
}

export interface KeeperRunResult extends KeeperDecision {
  executed: boolean;
  ok: boolean;
  tx_hash: string;
  explorer_url: string;
  keeperhub_audit_id?: string;
}

export interface KeeperOptions {
  thresholds?: Partial<PositionThresholds>;
  /** Evaluate + report only, never execute. Default false. */
  dryRun?: boolean;
}

export class CreditKeeper {
  private readonly engine: PositionEngine;
  private readonly dryRun: boolean;

  constructor(
    private readonly satellite: FlareCreditSatellite,
    private readonly ledger: Ledger,
    opts: KeeperOptions = {},
  ) {
    this.engine = new PositionEngine(satellite.vault, ledger, satellite.priceClient, opts.thresholds, satellite.collateral);
    this.dryRun = opts.dryRun ?? false;
  }

  /** Decide (but do not execute) what the keeper would do for one agent. */
  async evaluate(agentId: string): Promise<KeeperDecision> {
    const position = await this.engine.assess(agentId);
    if ((position.status === "margin_call" || position.status === "liquidation") && position.deleverage_fxrp > 0) {
      return {
        agent_id: agentId,
        action: "deleverage",
        amount_fxrp: position.deleverage_fxrp,
        reason:
          `health factor ${fmt(position.health_factor)} < margin-call ${position.thresholds.marginCall}; ` +
          `FTSO XRP/USD $${position.xrp_usd} marks the FXRP debt at $${position.debt_usd} (drift $${position.price_drift_usd}). ` +
          `Repay ${position.deleverage_fxrp} FXRP to restore HF ≥ ${position.thresholds.target}.`,
        position,
      };
    }
    return {
      agent_id: agentId,
      action: "none",
      amount_fxrp: 0,
      reason:
        position.status === "no_debt"
          ? "no FXRP debt — nothing to manage"
          : `position ${position.status} (HF ${fmt(position.health_factor)}) — no action needed`,
      position,
    };
  }

  /** Evaluate one agent and, if a protective action is due, execute it via KeeperHub. */
  async run(agentId: string): Promise<KeeperRunResult> {
    const decision = await this.evaluate(agentId);
    if (decision.action === "none" || this.dryRun) {
      return { ...decision, executed: false, ok: decision.action === "none", tx_hash: "", explorer_url: "" };
    }
    // Repay is capped at the agent's actual FXRP debt inside the vault.
    const amountSmallest = BigInt(Math.round(decision.amount_fxrp * 1e6));
    const res = await this.satellite.repay(agentId, amountSmallest);
    const audit = this.satellite.auditTrail(agentId).at(-1);
    return {
      ...decision,
      executed: true,
      ok: res.ok,
      tx_hash: res.tx_hash,
      explorer_url: res.explorer_url,
      keeperhub_audit_id: audit?.audit_id,
    };
  }

  /** Run the keeper across a fleet; returns per-agent results and a rollup. */
  async runFleet(agentIds: string[]): Promise<{
    results: KeeperRunResult[];
    summary: { evaluated: number; actioned: number; executed: number; total_deleveraged_fxrp: number; by_status: Record<string, number> };
  }> {
    const results: KeeperRunResult[] = [];
    const byStatus: Record<string, number> = {};
    for (const id of agentIds) {
      const r = await this.run(id);
      results.push(r);
      byStatus[r.position.status] = (byStatus[r.position.status] ?? 0) + 1;
    }
    const actioned = results.filter((r) => r.action !== "none");
    return {
      results,
      summary: {
        evaluated: results.length,
        actioned: actioned.length,
        executed: results.filter((r) => r.executed && r.ok).length,
        total_deleveraged_fxrp: round2(actioned.reduce((s, r) => s + (r.executed && r.ok ? r.amount_fxrp : 0), 0)),
        by_status: byStatus,
      },
    };
  }
}

function fmt(hf: number): string {
  return hf === Infinity ? "∞" : hf.toFixed(2);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
