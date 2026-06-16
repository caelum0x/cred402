import type { Ledger } from "../ledger/ledger.js";

/**
 * Service-category analytics — market intelligence aggregated by service type. A
 * buyer or operator wants to know which categories are active, creditworthy, and
 * where the money flows, not just individual agents. This rolls the agent roster up
 * by `service_type` into per-category supply (agents), quality (avg reputation /
 * credit), throughput (receipts) and revenue, plus the category's top earner.
 */

export interface CategoryStats {
  category: string;
  agent_count: number;
  avg_reputation: number;
  avg_credit_score: number;
  total_revenue_motes: string;
  total_receipts: number;
  top_agent: string | null;
}

export interface CategoryAnalytics {
  generated_at: number;
  categories: CategoryStats[];
}

export function buildCategoryAnalytics(ledger: Ledger): CategoryAnalytics {
  const agents = ledger.agents.list();
  const receipts = ledger.receipts.list();
  const receiptsBySeller = new Map<string, number>();
  for (const r of receipts) receiptsBySeller.set(r.seller_agent, (receiptsBySeller.get(r.seller_agent) ?? 0) + 1);

  const revenueOf = (id: string) => {
    const a = ledger.agents.get(id);
    return a ? a.x402_revenue_history.reduce((s, e) => s + e.amount, 0n) : 0n;
  };

  const byCategory = new Map<string, { agents: typeof agents; revenue: bigint }>();
  for (const a of agents) {
    const row = byCategory.get(a.service_type) ?? { agents: [], revenue: 0n };
    row.agents.push(a);
    row.revenue += revenueOf(a.agent_id);
    byCategory.set(a.service_type, row);
  }

  const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, n) => s + n, 0) / xs.length) : 0);

  const categories: CategoryStats[] = [...byCategory.entries()]
    .map(([category, row]) => {
      const topAgent = row.agents
        .slice()
        .sort((x, y) => (revenueOf(y.agent_id) > revenueOf(x.agent_id) ? 1 : -1))[0];
      return {
        category,
        agent_count: row.agents.length,
        avg_reputation: avg(row.agents.map((a) => a.reputation_score)),
        avg_credit_score: avg(row.agents.map((a) => a.credit_score)),
        total_revenue_motes: row.revenue.toString(),
        total_receipts: row.agents.reduce((s, a) => s + (receiptsBySeller.get(a.agent_id) ?? 0), 0),
        top_agent: topAgent?.agent_id ?? null,
      };
    })
    .sort((a, b) => (BigInt(b.total_revenue_motes) > BigInt(a.total_revenue_motes) ? 1 : -1));

  return { generated_at: ledger.clock.now(), categories };
}
