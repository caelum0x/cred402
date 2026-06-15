import type { Ledger } from "../lib/ledger/index.js";
import type { CreditLine } from "../lib/core/types.js";
import { cspr } from "../lib/core/units.js";

/**
 * TreasuryAgent — manages the DeFi pool's capital. It seeds liquidity, funds
 * agent credit draws, monitors repayment, and freezes lines when risk changes.
 * In a full build this is where the CSPR.trade MCP would route or hedge liquidity.
 */
export class TreasuryAgent {
  constructor(
    private readonly ledger: Ledger,
    private readonly provider = "TreasuryAgent",
  ) {}

  /** Seed the pool with liquidity providers' capital. */
  depositLiquidity(amountCspr: number): void {
    this.ledger.pool.deposit_liquidity(cspr(amountCspr), this.provider);
  }

  /** Fund an agent's working-capital draw against its open credit line. */
  fundDraw(agent_id: string, amountCspr: number): CreditLine {
    const gov = this.ledger.governance.get();
    if (gov.paused_credit_draws) throw new Error("credit draws are paused by governance");
    if (this.ledger.disputes.openCount(agent_id) > 0) throw new Error("agent has an open dispute; draw blocked");
    return this.ledger.pool.draw(agent_id, cspr(amountCspr));
  }

  /** Process a repayment (principal + accrued interest -> LP yield). */
  collectRepayment(agent_id: string, amountCspr: number) {
    return this.ledger.pool.repay(agent_id, cspr(amountCspr));
  }

  /** Defensive freeze when an agent's risk profile deteriorates. */
  freeze(agent_id: string, reason: string): void {
    this.ledger.pool.freeze(agent_id, reason);
  }
}
