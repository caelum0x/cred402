import type { Ledger } from "../ledger/ledger.js";

/**
 * x402 receipt-network statistics — analytics for Product B (the x402 payment
 * receipt network), distinct from the credit layer. Every paid agent interaction
 * mints a signed receipt; this rolls them up into volume, settlement status, the
 * busiest counterparties, and per-service breakdown — the heartbeat of agent-to-
 * agent commerce that feeds reputation and, ultimately, credit.
 */

export interface CounterpartyVolume {
  agent_id: string;
  receipts: number;
  volume_motes: string;
}

export interface X402Stats {
  generated_at: number;
  total_receipts: number;
  total_volume_motes: string;
  avg_receipt_motes: string;
  by_status: Record<string, number>;
  finalization_rate: number; // finalized / total, 0..1
  top_sellers: CounterpartyVolume[];
  top_payers: CounterpartyVolume[];
  by_service: { service_type: string; receipts: number; volume_motes: string }[];
}

function topBy(map: Map<string, { receipts: number; volume: bigint }>, n: number): CounterpartyVolume[] {
  return [...map.entries()]
    .map(([agent_id, v]) => ({ agent_id, receipts: v.receipts, volume_motes: v.volume.toString() }))
    .sort((a, b) => (BigInt(b.volume_motes) > BigInt(a.volume_motes) ? 1 : -1))
    .slice(0, n);
}

export function buildX402Stats(ledger: Ledger, topN = 5): X402Stats {
  const receipts = ledger.receipts.list();
  const total = receipts.reduce((s, r) => s + r.amount, 0n);

  const byStatus: Record<string, number> = {};
  const sellers = new Map<string, { receipts: number; volume: bigint }>();
  const payers = new Map<string, { receipts: number; volume: bigint }>();
  const services = new Map<string, { receipts: number; volume: bigint }>();

  const bump = (m: Map<string, { receipts: number; volume: bigint }>, key: string, amount: bigint) => {
    const row = m.get(key) ?? { receipts: 0, volume: 0n };
    row.receipts++;
    row.volume += amount;
    m.set(key, row);
  };

  for (const r of receipts) {
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    bump(sellers, r.seller_agent, r.amount);
    bump(payers, r.payer_agent, r.amount);
    bump(services, r.service_type, r.amount);
  }

  const finalized = byStatus["finalized"] ?? 0;
  return {
    generated_at: ledger.clock.now(),
    total_receipts: receipts.length,
    total_volume_motes: total.toString(),
    avg_receipt_motes: receipts.length ? (total / BigInt(receipts.length)).toString() : "0",
    by_status: byStatus,
    finalization_rate: receipts.length ? Math.round((finalized / receipts.length) * 100) / 100 : 0,
    top_sellers: topBy(sellers, topN),
    top_payers: topBy(payers, topN),
    by_service: [...services.entries()]
      .map(([service_type, v]) => ({ service_type, receipts: v.receipts, volume_motes: v.volume.toString() }))
      .sort((a, b) => (BigInt(b.volume_motes) > BigInt(a.volume_motes) ? 1 : -1)),
  };
}
