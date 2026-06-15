import type { Snapshot } from "./types";

export async function getSnapshot(): Promise<Snapshot> {
  const res = await fetch("/api/state");
  if (!res.ok) throw new Error(`state ${res.status}`);
  return res.json();
}

export async function runDemo(dispute = false): Promise<void> {
  await fetch(dispute ? "/api/demo/dispute" : "/api/demo/run", { method: "POST" });
}

export async function resetDemo(): Promise<void> {
  await fetch("/api/demo/reset", { method: "POST" });
}

export interface EconomicsView {
  fees: { facilitator_fee_bps: number; origination_fee_bps: number; interest_spread_bps: number; late_fee_bps: number };
  health: { utilization: number; realized_apy: number; realized_yield: string; loss_rate: number; risk_flags: string[] };
}

export async function getEconomics(): Promise<EconomicsView> {
  const res = await fetch("/api/economics");
  return res.json();
}

export interface ReasonCode { code: string; polarity: "positive" | "negative"; detail: string }
export interface CreditExplain {
  decision?: { credit_line: string; credit_score: number; interest_rate_bps: number; reason_codes?: ReasonCode[] };
  fraud_score?: number;
  realfi_multiplier?: number;
  eligible?: boolean;
  ineligible_reason?: string;
  error?: string;
}

export async function getCreditExplain(agentId: string): Promise<CreditExplain> {
  const res = await fetch(`/api/credit/explain/${encodeURIComponent(agentId)}`);
  return res.json();
}

export interface MarketListing {
  listing_id: string;
  agent_id: string;
  category: string;
  strategy: string;
  base_price: string;
  reputation_score: number;
  dispute_rate: number;
  receipt_count: number;
  supported_chains: string[];
}

export async function getMarketplace(): Promise<MarketListing[]> {
  const res = await fetch("/api/marketplace");
  return res.json();
}

export async function upgradePolicy(version: string): Promise<void> {
  await fetch("/api/policy/upgrade", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
}

const MOTES = 1_000_000_000;
export function fmtCspr(motes: string | number, decimals = 3): string {
  const n = Number(motes) / MOTES;
  return n.toLocaleString(undefined, { maximumFractionDigits: decimals });
}

export function shortHash(h: string, n = 10): string {
  if (!h) return "—";
  return h.length > n + 4 ? `${h.slice(0, n)}…${h.slice(-4)}` : h;
}

export function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString();
}
