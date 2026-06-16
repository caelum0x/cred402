import type { Ledger } from "../ledger/ledger.js";
import { computeTier } from "./reputation_tiers.js";

/**
 * Portfolio & concentration-risk report — the view an LP (or risk committee) needs
 * before adding liquidity: where is the pool's credit actually deployed, and how
 * concentrated is it? Concentration is the silent killer of a lending book, so we
 * compute a Herfindahl-Hirschman Index (HHI) over outstanding exposure plus the
 * single-name and single-sector caps, and surface tier/health-band breakdowns.
 *
 * HHI ranges 0..10000: <1500 competitive/diversified, 1500..2500 moderately
 * concentrated, >2500 highly concentrated (regulator convention, applied here to
 * a credit book rather than market share).
 */

export interface ExposureSlice {
  key: string;
  outstanding_motes: string;
  share_bps: number; // share of total outstanding, basis points
  lines: number;
}

export interface PortfolioReport {
  generated_at: number;
  total_liquidity_motes: string;
  outstanding_motes: string;
  free_liquidity_motes: string;
  utilization_bps: number;
  active_lines: number;
  defaults: number;
  hhi: number; // 0..10000 over outstanding exposure by agent
  concentration_band: "diversified" | "moderate" | "concentrated";
  largest_borrower: ExposureSlice | null;
  by_agent: ExposureSlice[];
  by_service_type: ExposureSlice[];
  by_tier: ExposureSlice[];
  by_health_band: ExposureSlice[];
}

type CreditStatus = string;

function healthBand(health_factor_bps: number, status: CreditStatus): string {
  if (status === "defaulted") return "defaulted";
  if (status === "frozen") return "frozen";
  if (health_factor_bps >= 15000) return "healthy";
  if (health_factor_bps >= 11000) return "watch";
  return "at_risk";
}

function shareBps(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * 10000n) / total);
}

function group(
  entries: { key: string; outstanding: bigint }[],
  total: bigint,
): ExposureSlice[] {
  const agg = new Map<string, { outstanding: bigint; lines: number }>();
  for (const e of entries) {
    const cur = agg.get(e.key) ?? { outstanding: 0n, lines: 0 };
    cur.outstanding += e.outstanding;
    cur.lines += 1;
    agg.set(e.key, cur);
  }
  return [...agg.entries()]
    .map(([key, v]) => ({
      key,
      outstanding_motes: v.outstanding.toString(),
      share_bps: shareBps(v.outstanding, total),
      lines: v.lines,
    }))
    .sort((a, b) => b.share_bps - a.share_bps);
}

export function buildPortfolioReport(ledger: Ledger): PortfolioReport {
  const pool = ledger.pool.poolState();
  const lines = ledger.pool.list();
  // Only deployed (drawn) credit contributes to concentration risk.
  const drawnLines = lines.filter((l) => l.drawn > 0n);
  const totalOutstanding = drawnLines.reduce((s, l) => s + l.drawn, 0n);

  const byAgentEntries = drawnLines.map((l) => ({ key: l.agent_id, outstanding: l.drawn }));
  const byServiceEntries = drawnLines.map((l) => ({
    key: ledger.agents.get(l.agent_id)?.service_type ?? "unknown",
    outstanding: l.drawn,
  }));
  const byTierEntries = drawnLines.map((l) => {
    const t = computeTier(ledger, l.agent_id);
    return { key: "tier" in t ? t.tier : "unrated", outstanding: l.drawn };
  });
  const byHealthEntries = drawnLines.map((l) => ({
    key: healthBand(l.health_factor_bps, l.status),
    outstanding: l.drawn,
  }));

  const byAgent = group(byAgentEntries, totalOutstanding);
  // HHI = sum of squared percentage shares (each share in whole-percent points).
  const hhi = Math.round(
    byAgent.reduce((s, slice) => {
      const pct = slice.share_bps / 100; // basis points → percent
      return s + pct * pct;
    }, 0),
  );
  const concentration_band: PortfolioReport["concentration_band"] =
    hhi < 1500 ? "diversified" : hhi <= 2500 ? "moderate" : "concentrated";

  const free = pool.total_liquidity - pool.outstanding_credit;
  return {
    generated_at: ledger.clock.now(),
    total_liquidity_motes: pool.total_liquidity.toString(),
    outstanding_motes: pool.outstanding_credit.toString(),
    free_liquidity_motes: (free < 0n ? 0n : free).toString(),
    utilization_bps: shareBps(pool.outstanding_credit, pool.total_liquidity),
    active_lines: lines.filter((l) => l.status === "active").length,
    defaults: pool.defaults,
    hhi,
    concentration_band,
    largest_borrower: byAgent[0] ?? null,
    by_agent: byAgent,
    by_service_type: group(byServiceEntries, totalOutstanding),
    by_tier: group(byTierEntries, totalOutstanding),
    by_health_band: group(byHealthEntries, totalOutstanding),
  };
}
