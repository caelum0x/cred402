import type { Ledger } from "../ledger/ledger.js";

/**
 * Per-agent cross-chain summary — Cred402 is "Casper-rooted, chain-executed", so an
 * agent's footprint spans satellites. This gathers one agent's address bindings,
 * Casper-anchored external receipts, Credit Authorization Notes, and its global
 * exposure into a single view: where the agent operates and how much credit it
 * controls off-Casper, all under the shared exposure cap.
 */

export interface AgentChainActivity {
  chain: string;
  bindings: number;
  external_receipts: number;
  external_volume: string; // summed external receipt amounts (string units)
  credit_notes: number;
}

export interface AgentMultichainSummary {
  agent_id: string;
  chains: AgentChainActivity[];
  global_exposure?: {
    outstanding: string;
    reserved: string;
    max_allowed: string;
    frozen: boolean;
  };
  total_bindings: number;
  total_external_receipts: number;
  total_credit_notes: number;
}

export function buildAgentMultichainSummary(ledger: Ledger, agentId: string): AgentMultichainSummary | { error: string } {
  if (!ledger.agents.get(agentId)) return { error: `unknown agent: ${agentId}` };

  const bindings = ledger.bindings.list().filter((b) => b.agent_id === agentId);
  const receipts = ledger.externalReceipts.list().filter((r) => r.seller_agent_id === agentId);
  const notes = ledger.notes.list().filter((n) => n.note.agent_id === agentId);

  const byChain = new Map<string, AgentChainActivity>();
  const ensure = (chain: string): AgentChainActivity => {
    let row = byChain.get(chain);
    if (!row) {
      row = { chain, bindings: 0, external_receipts: 0, external_volume: "0", credit_notes: 0 };
      byChain.set(chain, row);
    }
    return row;
  };

  for (const b of bindings) ensure(b.external_chain).bindings++;
  for (const r of receipts) {
    const row = ensure(r.origin_chain);
    row.external_receipts++;
    // amounts are decimal strings in the asset's smallest unit; sum as BigInt when integral.
    const prev = BigInt(row.external_volume);
    const add = /^\d+$/.test(r.amount) ? BigInt(r.amount) : 0n;
    row.external_volume = (prev + add).toString();
  }
  for (const n of notes) ensure(n.note.target_chain).credit_notes++;

  const exposure = ledger.exposure.get_agent_global_exposure(agentId);
  return {
    agent_id: agentId,
    chains: [...byChain.values()].sort((a, b) => b.external_receipts - a.external_receipts),
    global_exposure: exposure
      ? {
          outstanding: exposure.outstanding.toString(),
          reserved: exposure.reserved.toString(),
          max_allowed: exposure.max_allowed.toString(),
          frozen: exposure.frozen,
        }
      : undefined,
    total_bindings: bindings.length,
    total_external_receipts: receipts.length,
    total_credit_notes: notes.length,
  };
}
