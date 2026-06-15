import type { Agent, CreditLine, Receipt } from "../../core/types.js";
import type { AgentPassport } from "../../core/protocol_types.js";

/**
 * AgentPassport (p2 §6.2) — a read-optimized public trust profile aggregated from
 * the canonical contracts. The registry is the source of truth; the passport is
 * the integration surface other protocols and the MCP server read.
 */
export class AgentPassportRegistry {
  private readonly capabilities = new Map<string, string[]>();
  private readonly spendingLimits = new Map<string, bigint>();
  private readonly operators = new Map<string, string>();

  set_profile(agent_id: string, profile: { capabilities?: string[]; spending_limit?: bigint; operator?: string }): void {
    if (profile.capabilities) this.capabilities.set(agent_id, profile.capabilities);
    if (profile.spending_limit !== undefined) this.spendingLimits.set(agent_id, profile.spending_limit);
    if (profile.operator) this.operators.set(agent_id, profile.operator);
  }

  build(args: {
    agent: Agent;
    line?: CreditLine;
    receipts: Receipt[];
    open_disputes: number;
    now: number;
  }): AgentPassport {
    const { agent, line, receipts } = args;
    const sellerReceipts = receipts.filter((r) => r.seller_agent === agent.agent_id);
    const risk_flags: string[] = [];
    if (agent.dispute_rate > 0.05) risk_flags.push("elevated_dispute_rate");
    if (args.open_disputes > 0) risk_flags.push("open_dispute");
    if (line?.status === "frozen") risk_flags.push("credit_frozen");
    if (line?.status === "defaulted") risk_flags.push("defaulted");
    if (agent.stake === 0n) risk_flags.push("no_stake");

    return {
      agent_id: agent.agent_id,
      service_type: agent.service_type,
      operator: this.operators.get(agent.agent_id) ?? agent.owner_public_key,
      stake: agent.stake,
      reputation_score: agent.reputation_score,
      credit_score: agent.credit_score,
      credit_limit: line?.max_credit ?? 0n,
      outstanding_debt: line?.drawn ?? 0n,
      total_receipts: sellerReceipts.length + agent.x402_revenue_history.length,
      total_revenue: agent.x402_revenue_history.reduce((s, e) => s + e.amount, 0n),
      dispute_rate: agent.dispute_rate,
      capabilities: this.capabilities.get(agent.agent_id) ?? [],
      spending_limit: this.spendingLimits.get(agent.agent_id) ?? 0n,
      last_active_at: sellerReceipts.length ? Math.max(...sellerReceipts.map((r) => r.timestamp)) : agent.registered_at,
      risk_flags,
    };
  }
}
