import type { Ledger } from "../ledger/ledger.js";
import { simulateUnderwriting, type SimulationInput, type SimulationResult } from "./credit_simulator.js";

/**
 * Cred402 Credit Oracle (roadmap p3) — "Cred402 Inside".
 *
 * The read surface other x402 marketplaces/protocols query to make credit
 * decisions about an agent: a creditworthiness check, a hypothetical what-if
 * simulation, and a pre-approval. Backed by the same Casper-rooted ledger + risk
 * policy that underwrites credit natively — so a third party gets the *same*
 * answer Cred402 would. This is how Cred402 becomes the credit layer the rest of
 * the x402 economy builds on, not just a destination app.
 */

export interface CreditCheck {
  agent_id: string;
  exists: boolean;
  service_type?: string;
  credit_score: number; // 0..100
  reputation_score: number; // 0..100
  recommended_limit_motes: string;
  interest_rate_bps: number;
  eligible: boolean;
  ineligible_reason?: string;
  risk_flags: string[];
  /** Policy version that produced this answer (auditability). */
  policy_version: string;
  checked_at: number;
}

export class Cred402CreditOracle {
  constructor(private readonly ledger: Ledger) {}

  /** Read-only creditworthiness check for an agent (the core oracle call). */
  creditCheck(agentId: string): CreditCheck {
    const now = this.ledger.clock.now();
    const agent = this.ledger.agents.get(agentId);
    if (!agent) {
      return {
        agent_id: agentId, exists: false, credit_score: 0, reputation_score: 0,
        recommended_limit_motes: "0", interest_rate_bps: 0, eligible: false,
        ineligible_reason: "unknown agent", risk_flags: ["unknown_agent"],
        policy_version: this.ledger.policy.version(), checked_at: now,
      };
    }
    const decision = this.ledger.policy.evaluate(agent);
    const gov = this.ledger.governance.get();
    const openDisputes = this.ledger.disputes.openCount(agentId);

    const risk_flags: string[] = [];
    if (agent.reputation_score < gov.min_reputation_to_draw) risk_flags.push("below_min_reputation");
    if (openDisputes > 0) risk_flags.push("open_dispute");
    if (agent.dispute_rate > 0.05) risk_flags.push("elevated_dispute_rate");
    if (Number(agent.stake) === 0) risk_flags.push("no_stake");
    if (!agent.active) risk_flags.push("inactive");

    let eligible = true;
    let ineligible_reason: string | undefined;
    if (!agent.active) {
      eligible = false; ineligible_reason = "agent inactive";
    } else if (agent.reputation_score < gov.min_reputation_to_draw) {
      eligible = false; ineligible_reason = `reputation ${agent.reputation_score} below minimum ${gov.min_reputation_to_draw}`;
    } else if (openDisputes > 0) {
      eligible = false; ineligible_reason = `${openDisputes} open dispute(s)`;
    } else if (gov.paused_credit_draws) {
      eligible = false; ineligible_reason = "credit draws paused by governance";
    }

    return {
      agent_id: agentId,
      exists: true,
      service_type: agent.service_type,
      credit_score: decision.credit_score,
      reputation_score: agent.reputation_score,
      recommended_limit_motes: eligible ? decision.credit_line.toString() : "0",
      interest_rate_bps: decision.interest_rate_bps,
      eligible,
      ineligible_reason,
      risk_flags,
      policy_version: decision.policy_version,
      checked_at: now,
    };
  }

  /** Hypothetical what-if (read-only): preview a decision for signals an agent
   * doesn't have yet — e.g. a third party sizing a line before onboarding. */
  simulate(input: SimulationInput): SimulationResult {
    return simulateUnderwriting(this.ledger, input);
  }

  /** Batch check (e.g. a marketplace ranking its agents by creditworthiness). */
  creditChecks(agentIds: string[]): CreditCheck[] {
    return agentIds.map((id) => this.creditCheck(id));
  }
}
