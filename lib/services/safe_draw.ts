import type { Ledger } from "../ledger/ledger.js";

/**
 * Safe-draw advisor — how much more can an agent borrow without slipping out of a
 * healthy band? Drawing to the limit pins the health factor at 1.0 (max_credit ==
 * drawn), which trips risk monitoring; a prudent borrower targets a cushion. Given a
 * target health factor this returns the largest additional draw that keeps the line
 * at or above it, bounded by the line's headroom and the pool's free liquidity.
 */

const HEALTHY_HF_BPS = 15_000; // 1.5× — the "healthy" band in risk_alerts

export interface SafeDrawAdvice {
  agent_id: string;
  target_health_factor_bps: number;
  max_credit_motes: string;
  drawn_motes: string;
  available_motes: string; // raw headroom on the line
  pool_free_liquidity_motes: string;
  safe_additional_draw_motes: string; // additional draw that keeps HF ≥ target
  resulting_drawn_motes: string;
  resulting_health_factor_bps: number;
  limited_by: "target_health" | "line_headroom" | "pool_liquidity" | "none";
}

export function computeSafeDraw(ledger: Ledger, agentId: string, targetHfBps = HEALTHY_HF_BPS): SafeDrawAdvice | { error: string } {
  const line = ledger.pool.get(agentId);
  if (!line) return { error: `no credit line for ${agentId}` };
  if (line.status !== "active") return { error: `credit line is ${line.status}` };
  const target = Math.max(10_000, targetHfBps); // never below 1.0×

  const maxCredit = line.max_credit;
  const drawn = line.drawn;
  const headroom = maxCredit - drawn;
  const pool = ledger.pool.poolState();
  const free = pool.total_liquidity - pool.outstanding_credit;

  // HF = max_credit / drawn ≥ target/10000  ⇒  drawn ≤ max_credit * 10000 / target.
  const maxDrawnForTarget = (maxCredit * 10_000n) / BigInt(target);
  const byTarget = maxDrawnForTarget > drawn ? maxDrawnForTarget - drawn : 0n;

  // The binding constraint is the smallest of target-room, line headroom, free liquidity.
  let safe = byTarget;
  let limited: SafeDrawAdvice["limited_by"] = "target_health";
  if (headroom < safe) {
    safe = headroom < 0n ? 0n : headroom;
    limited = "line_headroom";
  }
  if (free < safe) {
    safe = free < 0n ? 0n : free;
    limited = "pool_liquidity";
  }
  if (safe === byTarget && byTarget > 0n && headroom >= byTarget && free >= byTarget) limited = "target_health";
  if (safe === 0n && byTarget === 0n) limited = "none";

  const resultingDrawn = drawn + safe;
  const resultingHf = resultingDrawn === 0n ? 50_000 : Math.min(50_000, Number((maxCredit * 10_000n) / resultingDrawn));

  return {
    agent_id: agentId,
    target_health_factor_bps: target,
    max_credit_motes: maxCredit.toString(),
    drawn_motes: drawn.toString(),
    available_motes: (headroom < 0n ? 0n : headroom).toString(),
    pool_free_liquidity_motes: (free < 0n ? 0n : free).toString(),
    safe_additional_draw_motes: safe.toString(),
    resulting_drawn_motes: resultingDrawn.toString(),
    resulting_health_factor_bps: resultingHf,
    limited_by: limited,
  };
}
