import type { Ledger } from "../ledger/ledger.js";
import type { CreditAgent } from "../../agents/credit_agent.js";

/**
 * Credit-line review — periodic re-underwriting of an existing line. As an agent
 * builds revenue and reputation it earns a higher limit, but credit that has
 * already been extended should never be yanked on a routine review (that would
 * punish good borrowers for a transient dip). So a review only ever *ratchets up*:
 * it raises the limit when the agent now qualifies for more, holds it otherwise,
 * and never auto-reduces. Reductions remain an explicit risk action (freeze).
 */

export type ReviewAction = "increased" | "held" | "ineligible";

export interface CreditReviewResult {
  agent_id: string;
  action: ReviewAction;
  previous_limit_motes: string;
  new_limit_motes: string;
  recommended_limit_motes: string; // what underwriting would grant fresh
  interest_rate_bps: number;
  credit_score: number;
  detail: string;
}

export function reviewCreditLine(ledger: Ledger, credit: CreditAgent, agentId: string): CreditReviewResult | { error: string } {
  const existing = ledger.pool.get(agentId);
  if (!existing) return { error: `no credit line to review for ${agentId}` };

  const explain = credit.explain(agentId);
  if ("error" in explain) return { error: explain.error };

  const previous = existing.max_credit;
  const recommended = explain.decision.credit_line;

  if (!explain.eligible) {
    return {
      agent_id: agentId,
      action: "ineligible",
      previous_limit_motes: previous.toString(),
      new_limit_motes: previous.toString(), // held — never yanked on review
      recommended_limit_motes: recommended.toString(),
      interest_rate_bps: existing.interest_rate_bps,
      credit_score: explain.decision.credit_score,
      detail: `agent no longer passes underwriting (${explain.ineligible_reason}); limit held, not reduced`,
    };
  }

  // Ratchet up only.
  if (recommended > previous) {
    const gov = ledger.governance.get();
    const line = ledger.pool.open_credit_line({
      agent_id: agentId,
      max_credit: recommended,
      interest_rate_bps: explain.decision.interest_rate_bps,
      origination_fee_bps: gov.origination_fee_bps,
      term_seconds: Math.max(1, existing.due_timestamp - ledger.clock.now()),
    });
    ledger.agents.set_credit_score(agentId, explain.decision.credit_score);
    return {
      agent_id: agentId,
      action: "increased",
      previous_limit_motes: previous.toString(),
      new_limit_motes: line.max_credit.toString(),
      recommended_limit_motes: recommended.toString(),
      interest_rate_bps: line.interest_rate_bps,
      credit_score: explain.decision.credit_score,
      detail: `limit raised on improved metrics`,
    };
  }

  return {
    agent_id: agentId,
    action: "held",
    previous_limit_motes: previous.toString(),
    new_limit_motes: previous.toString(),
    recommended_limit_motes: recommended.toString(),
    interest_rate_bps: existing.interest_rate_bps,
    credit_score: explain.decision.credit_score,
    detail: recommended < previous ? "fresh underwriting would grant less; limit held (not reduced on review)" : "limit unchanged",
  };
}
