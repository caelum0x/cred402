import type { CreditLine, PoolState } from "../../core/types.js";
import { deployHash } from "../../core/hash.js";
import { applyBps } from "../../core/units.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "AgentCreditPool";

/**
 * AgentCreditPool — the DeFi pool. Liquidity providers deposit CSPR; high-scoring
 * agents draw working capital against their verified x402 cash flow and repay
 * with interest. Mirrors `contracts/agent_credit_pool`.
 */
export class AgentCreditPool {
  private readonly lines = new Map<string, CreditLine>();
  private state: PoolState = {
    total_liquidity: 0n,
    outstanding_credit: 0n,
    interest_accrued: 0n,
    defaults: 0,
  };

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  deposit_liquidity(amount: bigint, provider: string): void {
    if (amount <= 0n) throw new Error("deposit must be positive");
    this.state.total_liquidity += amount;
    this.bus.emit("LiquidityDeposited", CONTRACT, deployHash(), {
      provider,
      amount: amount.toString(),
      total_liquidity: this.state.total_liquidity.toString(),
    });
  }

  withdraw_liquidity(amount: bigint): void {
    const available = this.state.total_liquidity - this.state.outstanding_credit;
    if (amount > available) throw new Error("insufficient free liquidity");
    this.state.total_liquidity -= amount;
  }

  open_credit_line(args: {
    agent_id: string;
    max_credit: bigint;
    interest_rate_bps: number;
    origination_fee_bps?: number;
    term_seconds: number;
  }): CreditLine {
    const now = this.clock.now();
    const drawn = this.lines.get(args.agent_id)?.drawn ?? 0n;
    const line: CreditLine = {
      agent_id: args.agent_id,
      max_credit: args.max_credit,
      drawn,
      interest_rate_bps: args.interest_rate_bps,
      origination_fee_bps: args.origination_fee_bps ?? 0,
      health_factor_bps: healthFactor(args.max_credit, drawn),
      opened_at: now,
      due_timestamp: now + args.term_seconds,
      status: "active",
    };
    this.lines.set(args.agent_id, line);
    this.bus.emit("CreditLineOpened", CONTRACT, deployHash(), {
      agent_id: line.agent_id,
      max_credit: line.max_credit.toString(),
      interest_rate_bps: line.interest_rate_bps,
      origination_fee_bps: line.origination_fee_bps,
      due_timestamp: line.due_timestamp,
    });
    return { ...line };
  }

  draw(agent_id: string, amount: bigint): CreditLine {
    const line = this.must(agent_id);
    if (line.status !== "active") throw new Error(`credit line ${line.status}, cannot draw`);
    if (line.drawn + amount > line.max_credit) throw new Error("draw exceeds max_credit");
    const free = this.state.total_liquidity - this.state.outstanding_credit;
    if (amount > free) throw new Error("pool has insufficient liquidity");
    line.drawn += amount;
    line.health_factor_bps = healthFactor(line.max_credit, line.drawn);
    this.state.outstanding_credit += amount;
    this.bus.emit("CreditDrawn", CONTRACT, deployHash(), {
      agent_id,
      amount: amount.toString(),
      drawn: line.drawn.toString(),
      health_factor_bps: line.health_factor_bps,
      due_timestamp: line.due_timestamp,
    });
    return { ...line };
  }

  /** Repay principal + accrued interest. Interest goes to LP yield. */
  repay(agent_id: string, amount: bigint): { line: CreditLine; interest: bigint } {
    const line = this.must(agent_id);
    const interest = this.accruedInterest(line);
    const principalPortion = amount > interest ? amount - interest : 0n;
    const principal = principalPortion > line.drawn ? line.drawn : principalPortion;
    const interestPaid = amount - principal;

    line.drawn -= principal;
    this.state.outstanding_credit -= principal;
    this.state.interest_accrued += interestPaid;
    this.state.total_liquidity += interestPaid; // interest compounds into the pool

    if (line.drawn === 0n && line.status === "active") {
      // reset the term window after full repayment
      line.opened_at = this.clock.now();
      line.due_timestamp = this.clock.now() + (line.due_timestamp - line.opened_at);
    }
    this.bus.emit("CreditRepaid", CONTRACT, deployHash(), {
      agent_id,
      amount: amount.toString(),
      principal: principal.toString(),
      interest: interestPaid.toString(),
      remaining: line.drawn.toString(),
    });
    return { line: { ...line }, interest: interestPaid };
  }

  freeze(agent_id: string, reason: string): void {
    const line = this.lines.get(agent_id);
    if (!line) return;
    line.status = "frozen";
    this.bus.emit("CreditFrozen", CONTRACT, deployHash(), { agent_id, reason });
  }

  /** Mark a line defaulted (called by Watchdog on missed repayment). */
  liquidate(agent_id: string): bigint {
    const line = this.must(agent_id);
    const loss = line.drawn;
    line.status = "defaulted";
    line.health_factor_bps = 0;
    this.state.outstanding_credit -= loss;
    this.state.total_liquidity -= loss; // pool absorbs the loss net of slashed stake
    this.state.defaults += 1;
    this.bus.emit("CreditDefaulted", CONTRACT, deployHash(), { agent_id, loss: loss.toString() });
    return loss;
  }

  /** Simple linear interest accrual since opening, prorated by APR. */
  accruedInterest(line: CreditLine): bigint {
    if (line.drawn === 0n) return 0n;
    const elapsed = Math.max(0, this.clock.now() - line.opened_at);
    const yearFraction = elapsed / (365 * 24 * 60 * 60);
    const fullYear = applyBps(line.drawn, BigInt(line.interest_rate_bps));
    return (fullYear * BigInt(Math.round(yearFraction * 1e9))) / 1_000_000_000n;
  }

  isOverdue(agent_id: string): boolean {
    const line = this.lines.get(agent_id);
    return !!line && line.drawn > 0n && this.clock.now() > line.due_timestamp;
  }

  get(agent_id: string): CreditLine | undefined {
    const l = this.lines.get(agent_id);
    return l ? { ...l } : undefined;
  }

  list(): CreditLine[] {
    return [...this.lines.values()].map((l) => ({ ...l }));
  }

  poolState(): PoolState {
    return { ...this.state };
  }

  /** Naive APY estimate for the dashboard: interest / liquidity, annualized roughly. */
  estimatedApy(): number {
    if (this.state.total_liquidity === 0n) return 0;
    return Number(this.state.interest_accrued) / Number(this.state.total_liquidity);
  }

  private must(agent_id: string): CreditLine {
    const l = this.lines.get(agent_id);
    if (!l) throw new Error(`no credit line for agent: ${agent_id}`);
    return l;
  }
}

/** Health factor in bps: max_credit / drawn, capped at 5.0; 10000 (=1.0) when undrawn. */
function healthFactor(max_credit: bigint, drawn: bigint): number {
  if (drawn === 0n) return 50_000;
  const hf = Number((max_credit * 10_000n) / drawn);
  return Math.min(50_000, hf);
}
