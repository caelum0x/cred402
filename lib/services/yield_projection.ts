import type { Ledger } from "../ledger/ledger.js";
import { ProtocolEconomics } from "../core/economics.js";

/**
 * LP forward yield projection — the complement to the honest *realized* APY. LPs
 * deciding whether to add liquidity need a forward view: given the credit book as
 * it stands today (drawn balances, their rates) and a stated loss assumption, what
 * net yield should an LP expect over 30 / 90 / 365 days? This is explicitly a
 * projection (assumption-driven), kept separate from realized accounting so the two
 * are never conflated.
 */

const YEAR_SECONDS = 365 * 24 * 60 * 60;
const HORIZONS_DAYS = [30, 90, 365];

export interface YieldHorizon {
  horizon_days: number;
  gross_interest_motes: string; // interest the book throws off over the horizon
  lp_interest_motes: string; // after the protocol spread
  expected_loss_motes: string; // outstanding × loss assumption × horizon
  net_lp_yield_motes: string; // lp_interest − expected_loss
  projected_apy: number; // net yield annualized over deployed capital, 0..1+
}

export interface YieldProjection {
  generated_at: number;
  total_liquidity_motes: string;
  outstanding_motes: string;
  utilization: number;
  weighted_avg_apr_bps: number; // drawn-weighted interest rate across lines
  loss_assumption: number; // annualized, derived from realized losses (0..1)
  protocol_spread_bps: number;
  horizons: YieldHorizon[];
}

export function buildYieldProjection(ledger: Ledger, economics: ProtocolEconomics): YieldProjection {
  const now = ledger.clock.now();
  const pool = ledger.pool.poolState();
  const lines = ledger.pool.list().filter((l) => l.drawn > 0n);

  const outstanding = lines.reduce((s, l) => s + l.drawn, 0n);
  const totalLiquidity = pool.total_liquidity;
  const utilization = totalLiquidity > 0n ? Number(pool.outstanding_credit) / Number(totalLiquidity) : 0;

  // Annual gross interest = Σ drawn × apr. Track the drawn-weighted average APR.
  let annualGross = 0n;
  let weightedRateNumerator = 0n;
  for (const l of lines) {
    annualGross += (l.drawn * BigInt(l.interest_rate_bps)) / 10_000n;
    weightedRateNumerator += l.drawn * BigInt(l.interest_rate_bps);
  }
  const weighted_avg_apr_bps = outstanding > 0n ? Number(weightedRateNumerator / outstanding) : 0;

  // Loss assumption (forward, annualized): derived from realized defaults — the
  // share of currently-open lines that have defaulted, capped at 50%. Zero when the
  // book has no default history. This is a stated assumption, not a measured rate.
  const openLines = ledger.pool.list().length;
  const lossRate = pool.defaults > 0 && openLines > 0 ? Math.min(0.5, pool.defaults / openLines) : 0;

  const protocol_spread_bps = Number(economics.protocolInterestShare(10_000n)); // spread on 1.0 unit → bps

  const deployed = Number(outstanding);
  const horizons: YieldHorizon[] = HORIZONS_DAYS.map((days) => {
    const frac = (days * 24 * 60 * 60) / YEAR_SECONDS;
    const gross = BigInt(Math.round(Number(annualGross) * frac));
    const lpInterest = economics.lpInterestShare(gross);
    const expectedLoss = BigInt(Math.round(deployed * lossRate * frac));
    const net = lpInterest - expectedLoss;
    const projected_apy = deployed > 0 ? Number(net) / deployed / frac : 0;
    return {
      horizon_days: days,
      gross_interest_motes: gross.toString(),
      lp_interest_motes: lpInterest.toString(),
      expected_loss_motes: expectedLoss.toString(),
      net_lp_yield_motes: net.toString(),
      projected_apy,
    };
  });

  return {
    generated_at: now,
    total_liquidity_motes: totalLiquidity.toString(),
    outstanding_motes: outstanding.toString(),
    utilization,
    weighted_avg_apr_bps,
    loss_assumption: lossRate,
    protocol_spread_bps,
    horizons,
  };
}
