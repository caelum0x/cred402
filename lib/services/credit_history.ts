import type { Ledger } from "../ledger/ledger.js";
import type { ChainEvent } from "../core/types.js";

/**
 * Agent credit history — the bureau's "credit file": every on-chain event that
 * concerns one agent, in chronological order, classified into the categories a
 * credit analyst reads (identity, revenue, credit, disputes, reputation,
 * cross-chain). Built purely from the canonical event log, so it is a faithful,
 * tamper-evident audit trail rather than a separate store.
 */

export type HistoryCategory =
  | "identity"
  | "revenue"
  | "credit"
  | "dispute"
  | "reputation"
  | "crosschain"
  | "other";

export interface HistoryEntry {
  seq: number;
  timestamp: number;
  event: string;
  category: HistoryCategory;
  summary: string;
  data: Record<string, unknown>;
}

export interface CreditHistory {
  agent_id: string;
  entries: HistoryEntry[];
  counts: Record<HistoryCategory, number>;
  first_seen?: number;
  last_activity?: number;
}

// The various field names under which an event references an agent.
const AGENT_KEYS = ["agent_id", "seller_agent", "seller_agent_id", "respondent_agent", "payer_agent", "provider", "from", "to"];

function mentionsAgent(e: ChainEvent, agentId: string): boolean {
  for (const k of AGENT_KEYS) {
    if (e.data[k] === agentId) return true;
  }
  return false;
}

function categorize(name: string): HistoryCategory {
  if (/Registered|Passport|Profile|Capabilit|Operator|Verifi/i.test(name)) return "identity";
  if (/Receipt|Revenue|Fiat|x402|Purchase|Settl/i.test(name)) return "revenue";
  if (/Credit|Liquidity|Draw|Repaid|Default|Line|Stake|Underwr/i.test(name)) return "credit";
  if (/Dispute|Slash|Verdict|Insurance/i.test(name)) return "dispute";
  if (/Reputation|Attest/i.test(name)) return "reputation";
  if (/Binding|External|Anchor|CAN|Exposure|Chain/i.test(name)) return "crosschain";
  return "other";
}

function summarize(e: ChainEvent): string {
  const d = e.data;
  const amount = d.amount ?? d.max_credit ?? d.max_draw ?? d.slash_cspr;
  const parts: string[] = [];
  if (amount !== undefined) parts.push(`amount=${String(amount)}`);
  if (d.reason_code !== undefined) parts.push(String(d.reason_code));
  if (d.verdict !== undefined) parts.push(`verdict=${String(d.verdict)}`);
  if (d.status !== undefined) parts.push(`status=${String(d.status)}`);
  if (d.previous !== undefined && d.current !== undefined) parts.push(`${String(d.previous)}→${String(d.current)}`);
  if (d.external_chain !== undefined) parts.push(`chain=${String(d.external_chain)}`);
  return parts.join(" · ") || e.name;
}

export function buildCreditHistory(ledger: Ledger, agentId: string): CreditHistory | { error: string } {
  if (!ledger.agents.get(agentId)) return { error: `unknown agent: ${agentId}` };

  const counts: Record<HistoryCategory, number> = {
    identity: 0, revenue: 0, credit: 0, dispute: 0, reputation: 0, crosschain: 0, other: 0,
  };
  const entries: HistoryEntry[] = ledger.bus
    .all()
    .filter((e) => mentionsAgent(e, agentId))
    .map((e) => {
      const category = categorize(e.name);
      counts[category]++;
      return { seq: e.seq, timestamp: e.timestamp, event: e.name, category, summary: summarize(e), data: e.data };
    });

  return {
    agent_id: agentId,
    entries,
    counts,
    first_seen: entries[0]?.timestamp,
    last_activity: entries[entries.length - 1]?.timestamp,
  };
}
