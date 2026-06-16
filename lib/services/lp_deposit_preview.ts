import type { Ledger } from "../ledger/ledger.js";
import type { ProtocolEconomics } from "../core/economics.js";
import { cspr } from "../core/units.js";
import { buildYieldProjection } from "./yield_projection.js";

/**
 * LP deposit preview — the lender's counterpart to the borrower's credit simulator.
 * Before committing liquidity, an LP wants to know: what share of the pool would I
 * hold, and what yield should I expect on it? This previews the resulting pool size,
 * the depositor's share, and a forward yield estimate (their pro-rata slice of the
 * book's projected LP interest), without moving any funds.
 */

export interface LpDepositPreview {
  deposit_cspr: number;
  current_liquidity_motes: string;
  resulting_liquidity_motes: string;
  resulting_share: number; // 0..1 of the pool after the deposit
  resulting_utilization: number; // outstanding / new liquidity
  projected_apy: number; // the book's forward LP APY (365d)
  projected_annual_yield_motes: string; // deposit × projected_apy (pro-rata)
}

export function buildLpDepositPreview(ledger: Ledger, economics: ProtocolEconomics, depositCspr: number): LpDepositPreview | { error: string } {
  if (!(depositCspr > 0)) return { error: "deposit must be positive" };
  const deposit = cspr(depositCspr);
  const pool = ledger.pool.poolState();
  const resultingLiquidity = pool.total_liquidity + deposit;
  const share = resultingLiquidity > 0n ? Number(deposit) / Number(resultingLiquidity) : 0;
  const utilization = resultingLiquidity > 0n ? Number(pool.outstanding_credit) / Number(resultingLiquidity) : 0;

  // Use the book's forward 365-day LP APY as the per-CSPR yield estimate.
  const projection = buildYieldProjection(ledger, economics);
  const annual = projection.horizons.find((h) => h.horizon_days === 365);
  const apy = annual?.projected_apy ?? 0;

  return {
    deposit_cspr: depositCspr,
    current_liquidity_motes: pool.total_liquidity.toString(),
    resulting_liquidity_motes: resultingLiquidity.toString(),
    resulting_share: Math.round(share * 10000) / 10000,
    resulting_utilization: Math.round(utilization * 10000) / 10000,
    projected_apy: apy,
    projected_annual_yield_motes: BigInt(Math.round(Number(deposit) * apy)).toString(),
  };
}
