import type { Ledger } from "../ledger/ledger.js";
import type { ProtocolEconomics } from "../core/economics.js";
import { cspr, applyBps } from "../core/units.js";

/**
 * Credit cost calculator — transparency for a borrower about to draw. Given an
 * agent's open line and a draw amount, it itemizes the full cost: the upfront
 * origination fee, the interest accrued over the line's remaining term, the total
 * to repay, and the effective all-in cost. No surprises: every number is derived
 * from the line's on-chain terms and the protocol fee schedule.
 */

const YEAR_SECONDS = 365 * 24 * 60 * 60;

export interface CreditCost {
  agent_id: string;
  draw_cspr: number;
  draw_motes: string;
  origination_fee_motes: string; // taken upfront
  interest_estimate_motes: string; // over the remaining term
  total_repayment_motes: string; // principal + interest (repaid over the term)
  all_in_cost_motes: string; // origination + interest
  effective_cost_pct: number; // all-in cost as a share of the draw
  interest_rate_bps: number;
  origination_fee_bps: number;
  term_days: number;
  available_motes: string; // headroom on the line
}

export function computeCreditCost(
  ledger: Ledger,
  economics: ProtocolEconomics,
  agentId: string,
  drawCspr: number,
): CreditCost | { error: string } {
  const line = ledger.pool.get(agentId);
  if (!line) return { error: `no credit line for ${agentId}` };
  if (line.status !== "active") return { error: `credit line is ${line.status}` };
  if (!(drawCspr > 0)) return { error: "draw amount must be positive" };

  const draw = cspr(drawCspr);
  const available = line.max_credit - line.drawn;
  if (draw > available) {
    return { error: `draw ${drawCspr} CSPR exceeds available headroom (${Number(available) / 1e9} CSPR)` };
  }

  const termSeconds = Math.max(0, line.due_timestamp - ledger.clock.now());
  const termFraction = termSeconds / YEAR_SECONDS;

  const origination = economics.originationFee(draw);
  const annualInterest = applyBps(draw, BigInt(line.interest_rate_bps));
  const interest = BigInt(Math.round(Number(annualInterest) * termFraction));
  const allIn = origination + interest;

  return {
    agent_id: agentId,
    draw_cspr: drawCspr,
    draw_motes: draw.toString(),
    origination_fee_motes: origination.toString(),
    interest_estimate_motes: interest.toString(),
    total_repayment_motes: (draw + interest).toString(),
    all_in_cost_motes: allIn.toString(),
    effective_cost_pct: draw > 0n ? Math.round((Number(allIn) / Number(draw)) * 10000) / 100 : 0,
    interest_rate_bps: line.interest_rate_bps,
    origination_fee_bps: line.origination_fee_bps,
    term_days: Math.round(termSeconds / 86_400),
    available_motes: available.toString(),
  };
}
