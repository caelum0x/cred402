import type { Ledger } from "../ledger/ledger.js";

/**
 * Liquidity-provider positions — reconstructed from LiquidityDeposited events.
 *
 * Aggregates deposits per provider, computes each LP's share of the pool, and
 * attributes accrued interest pro-rata into an estimated yield. This is the data
 * behind the console's LP position view and an honest "what have I earned"
 * answer for liquidity providers.
 */

export interface LpPosition {
  provider: string;
  deposited_motes: string;
  share: number; // 0..1 of total liquidity
  estimated_yield_motes: string;
  estimated_apy: number;
}

export interface LpView {
  total_liquidity_motes: string;
  outstanding_motes: string;
  interest_accrued_motes: string;
  utilization: number;
  positions: LpPosition[];
}

export function buildLpView(ledger: Ledger): LpView {
  const pool = ledger.pool.poolState();
  const deposits = new Map<string, bigint>();
  for (const e of ledger.bus.all()) {
    if (e.name !== "LiquidityDeposited") continue;
    const d = e.data as { provider?: string; amount?: string };
    if (!d.provider) continue;
    deposits.set(d.provider, (deposits.get(d.provider) ?? 0n) + BigInt(d.amount ?? "0"));
  }

  const totalDeposited = [...deposits.values()].reduce((s, v) => s + v, 0n);
  const interest = pool.interest_accrued;
  const liquidity = pool.total_liquidity;
  const utilization = Number(liquidity) > 0 ? Number(pool.outstanding_credit) / Number(liquidity) : 0;

  const positions: LpPosition[] = [...deposits.entries()]
    .map(([provider, amount]) => {
      const share = totalDeposited > 0n ? Number(amount) / Number(totalDeposited) : 0;
      const yieldMotes = totalDeposited > 0n ? (interest * amount) / totalDeposited : 0n;
      // Naive APY: realized yield over principal (not annualized without a window).
      const apy = Number(amount) > 0 ? Number(yieldMotes) / Number(amount) : 0;
      return {
        provider,
        deposited_motes: amount.toString(),
        share,
        estimated_yield_motes: yieldMotes.toString(),
        estimated_apy: Math.round(apy * 10000) / 10000,
      };
    })
    .sort((a, b) => Number(b.deposited_motes) - Number(a.deposited_motes));

  return {
    total_liquidity_motes: liquidity.toString(),
    outstanding_motes: pool.outstanding_credit.toString(),
    interest_accrued_motes: interest.toString(),
    utilization,
    positions,
  };
}
