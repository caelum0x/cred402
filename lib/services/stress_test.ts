import type { Ledger } from "../ledger/ledger.js";

/**
 * Pool stress test (p2 §simulations) — model a default wave and report whether
 * the credit pool stays solvent.
 *
 * Assumes a fraction of outstanding credit defaults; losses hit liquidity, partly
 * cushioned by the insurance reserve. Returns the post-shock liquidity, coverage
 * ratio, and a solvency verdict so LPs/operators can size risk before it happens.
 */

export interface StressScenario {
  default_rate: number; // 0..1 of outstanding credit assumed to default
  recovery_rate?: number; // 0..1 recovered from slashed stake / collateral
}

export interface StressResult {
  default_rate: number;
  recovery_rate: number;
  total_liquidity_motes: string;
  outstanding_motes: string;
  insurance_reserve_motes: string;
  gross_loss_motes: string;
  net_loss_motes: string; // after recovery + insurance
  liquidity_after_motes: string;
  coverage_ratio: number; // liquidity_after / (liquidity - outstanding), >1 healthy
  solvent: boolean;
}

export function runStressTest(ledger: Ledger, scenario: StressScenario): StressResult {
  const pool = ledger.pool.poolState();
  const reserveStr = ledger.slashing.reserveBalances().insurance_reserve;
  const insurance = BigInt(reserveStr);
  const defaultRate = clamp01(scenario.default_rate);
  const recoveryRate = clamp01(scenario.recovery_rate ?? 0.3);

  const grossLoss = scaleBig(pool.outstanding_credit, defaultRate);
  const recovered = scaleBig(grossLoss, recoveryRate);
  const afterRecovery = grossLoss - recovered;
  const fromInsurance = afterRecovery > insurance ? insurance : afterRecovery;
  const netLoss = afterRecovery - fromInsurance;

  const liquidityAfter = pool.total_liquidity - netLoss;
  const freeBefore = pool.total_liquidity - pool.outstanding_credit;
  const coverage = Number(freeBefore) > 0 ? Number(liquidityAfter) / Number(freeBefore) : liquidityAfter >= 0n ? 1 : 0;

  return {
    default_rate: defaultRate,
    recovery_rate: recoveryRate,
    total_liquidity_motes: pool.total_liquidity.toString(),
    outstanding_motes: pool.outstanding_credit.toString(),
    insurance_reserve_motes: insurance.toString(),
    gross_loss_motes: grossLoss.toString(),
    net_loss_motes: netLoss.toString(),
    liquidity_after_motes: liquidityAfter.toString(),
    coverage_ratio: Math.round(coverage * 1000) / 1000,
    solvent: liquidityAfter >= pool.outstanding_credit - grossLoss,
  };
}

/** Sweep default rates 10%..100% for a stress curve. */
export function stressCurve(ledger: Ledger, recoveryRate = 0.3): StressResult[] {
  return [0.1, 0.25, 0.5, 0.75, 1.0].map((r) => runStressTest(ledger, { default_rate: r, recovery_rate: recoveryRate }));
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function scaleBig(value: bigint, ratio: number): bigint {
  const scaled = Math.round(ratio * 1e9);
  return (value * BigInt(scaled)) / 1_000_000_000n;
}
