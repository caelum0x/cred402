import type { Ledger } from "../ledger/ledger.js";
import { shortId } from "../core/hash.js";

/**
 * On-protocol governance proposals (p2 §6.11 / governance contract).
 *
 * Agents propose parameter changes, vote with reputation-weighted power, and a
 * passed proposal executes the change on the Governance contract. Real, auditable
 * governance: create → vote → tally → execute, with a quorum + majority gate.
 */

export type ProposalStatus = "open" | "queued" | "rejected" | "executed";

export interface Proposal {
  id: string;
  title: string;
  param_key: string;
  new_value: number | boolean;
  proposer: string;
  votes_for: number; // reputation-weighted
  votes_against: number;
  voters: string[];
  status: ProposalStatus;
  created_at: number;
  /** When a passed proposal may be applied (timelock guardrail, p2 §6.11). */
  eta?: number;
}

export class GovernanceProposals {
  private readonly proposals = new Map<string, Proposal>();

  constructor(
    private readonly ledger: Ledger,
    private readonly quorum = 100, // min total weighted votes to be valid
    private readonly timelockSeconds = 0, // delay before a passed proposal applies
  ) {}

  create(input: { title: string; param_key: string; new_value: number | boolean; proposer: string }): Proposal {
    if (!this.ledger.agents.get(input.proposer)) throw new Error("proposer must be a registered agent");
    const p: Proposal = {
      id: shortId("prop"),
      title: input.title,
      param_key: input.param_key,
      new_value: input.new_value,
      proposer: input.proposer,
      votes_for: 0,
      votes_against: 0,
      voters: [],
      status: "open",
      created_at: this.ledger.clock.now(),
    };
    this.proposals.set(p.id, p);
    return p;
  }

  /** Vote with reputation-weighted power; one vote per agent. */
  vote(proposalId: string, agentId: string, support: boolean): Proposal {
    const p = this.must(proposalId);
    if (p.status !== "open") throw new Error("proposal is not open");
    const agent = this.ledger.agents.get(agentId);
    if (!agent) throw new Error("voter must be a registered agent");
    if (p.voters.includes(agentId)) throw new Error("agent already voted");
    const weight = Math.max(1, agent.reputation_score);
    if (support) p.votes_for += weight;
    else p.votes_against += weight;
    p.voters.push(agentId);
    return p;
  }

  /** Tally a proposal: reject, or queue it (subject to the timelock) for apply(). */
  execute(proposalId: string): Proposal {
    const p = this.must(proposalId);
    if (p.status !== "open") throw new Error("proposal already finalized");
    const total = p.votes_for + p.votes_against;
    if (total < this.quorum) throw new Error(`quorum not met (${total}/${this.quorum})`);
    if (p.votes_for <= p.votes_against) {
      p.status = "rejected";
      return p;
    }
    p.status = "queued";
    p.eta = this.ledger.clock.now() + this.timelockSeconds;
    if (this.timelockSeconds === 0) return this.apply(proposalId);
    return p;
  }

  /** Apply a queued proposal once its timelock has elapsed. */
  apply(proposalId: string): Proposal {
    const p = this.must(proposalId);
    if (p.status !== "queued") throw new Error("proposal is not queued");
    if (p.eta !== undefined && this.ledger.clock.now() < p.eta) {
      throw new Error(`timelock active until ${p.eta} (now ${this.ledger.clock.now()})`);
    }
    if (p.param_key.startsWith("paused_")) {
      const area = p.param_key.replace("paused_", "") as "credit_draws" | "registrations" | "receipt_finalization";
      if (p.new_value) this.ledger.governance.pause(area);
      else this.ledger.governance.unpause(area);
    } else {
      this.ledger.governance.set_param(p.param_key as never, p.new_value as never);
    }
    p.status = "executed";
    return p;
  }

  get(proposalId: string): Proposal | undefined {
    return this.proposals.get(proposalId);
  }

  list(): Proposal[] {
    return [...this.proposals.values()].sort((a, b) => b.created_at - a.created_at);
  }

  private must(id: string): Proposal {
    const p = this.proposals.get(id);
    if (!p) throw new Error(`unknown proposal: ${id}`);
    return p;
  }
}
