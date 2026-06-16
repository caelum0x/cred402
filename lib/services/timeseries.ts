import type { Ledger } from "../ledger/ledger.js";

/**
 * Protocol time-series — cumulative metrics reconstructed from the event log.
 *
 * Walks the ordered event stream and tracks running pool liquidity, outstanding
 * credit, and receipt count at each step, producing chartable series (CSPR). The
 * console renders these as SVG sparklines; downsampled to a point cap so the
 * payload stays small regardless of history length.
 */

export interface SeriesPoint {
  seq: number;
  liquidity: number; // CSPR
  outstanding: number; // CSPR
  receipts: number;
}

const MOTES = 1e9;

export function buildTimeseries(ledger: Ledger, maxPoints = 120): SeriesPoint[] {
  let liquidity = 0n;
  let outstanding = 0n;
  let receipts = 0;
  const points: SeriesPoint[] = [];

  for (const e of ledger.bus.all()) {
    const d = e.data as Record<string, unknown>;
    switch (e.name) {
      case "LiquidityDeposited":
        liquidity = BigInt((d.total_liquidity as string) ?? liquidity.toString());
        break;
      case "ReceiptRecorded":
        receipts++;
        break;
      case "CreditDrawn":
        outstanding += BigInt((d.amount as string) ?? "0");
        break;
      case "CreditRepaid":
        outstanding -= BigInt((d.principal as string) ?? "0");
        if (outstanding < 0n) outstanding = 0n;
        break;
      case "CreditDefaulted":
        outstanding -= BigInt((d.loss as string) ?? "0");
        if (outstanding < 0n) outstanding = 0n;
        break;
      default:
        continue; // only record a point on a metric-changing event
    }
    points.push({
      seq: e.seq,
      liquidity: Number(liquidity) / MOTES,
      outstanding: Number(outstanding) / MOTES,
      receipts,
    });
  }

  return downsample(points, maxPoints);
}

function downsample(points: SeriesPoint[], max: number): SeriesPoint[] {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out: SeriesPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
