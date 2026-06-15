import type { Agent, RevenueEvent, ServiceType } from "../../core/types.js";
import { deployHash } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "AgentRegistry";

/**
 * AgentRegistry — registers autonomous agents and tracks their on-chain identity,
 * stake, reputation and credit score. Mirrors `contracts/agent_registry`.
 */
export class AgentRegistry {
  private readonly agents = new Map<string, Agent>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  register_agent(args: {
    agent_id: string;
    owner_public_key: string;
    agent_public_key: string;
    service_type: ServiceType;
  }): Agent {
    if (this.agents.has(args.agent_id)) {
      throw new Error(`agent ${args.agent_id} already registered`);
    }
    const agent: Agent = {
      agent_id: args.agent_id,
      owner_public_key: args.owner_public_key,
      agent_public_key: args.agent_public_key,
      service_type: args.service_type,
      stake: 0n,
      total_jobs_completed: 0,
      x402_revenue_history: [],
      accuracy_score: 80, // neutral starting accuracy
      dispute_rate: 0,
      reputation_score: 70, // neutral starting reputation
      credit_score: 0,
      active: true,
      registered_at: this.clock.now(),
    };
    this.agents.set(agent.agent_id, agent);
    this.bus.emit("AgentRegistered", CONTRACT, deployHash(), {
      agent_id: agent.agent_id,
      service_type: agent.service_type,
    });
    return { ...agent };
  }

  stake(agent_id: string, amount: bigint): void {
    const a = this.must(agent_id);
    a.stake += amount;
    this.bus.emit("Staked", CONTRACT, deployHash(), { agent_id, amount: amount.toString(), total_stake: a.stake.toString() });
  }

  slash(agent_id: string, amount: bigint, reason_hash: string): void {
    const a = this.must(agent_id);
    const slashed = amount > a.stake ? a.stake : amount;
    a.stake -= slashed;
    this.bus.emit("StakeSlashed", CONTRACT, deployHash(), { agent_id, amount: slashed.toString(), reason_hash });
  }

  /** Apply a reputation delta (clamped 0..100) with an evidence hash. */
  update_reputation(agent_id: string, delta: number, evidence_hash: string, reason_code?: string): number {
    const a = this.must(agent_id);
    const prev = a.reputation_score;
    a.reputation_score = Math.max(0, Math.min(100, a.reputation_score + delta));
    // Reputation events carry a reason code (p5 §10) so the indexer/dashboard can
    // explain every score change; defaults follow the delta direction.
    const code = reason_code ?? (delta >= 0 ? "FINALIZED_VERIFIED_SERVICE" : "DISPUTE_OR_DEFAULT");
    this.bus.emit("ReputationUpdated", CONTRACT, deployHash(), {
      agent_id,
      previous: prev,
      current: a.reputation_score,
      delta,
      evidence_hash,
      reason_code: code,
      source_id: evidence_hash,
    });
    return a.reputation_score;
  }

  set_credit_score(agent_id: string, score: number): void {
    const a = this.must(agent_id);
    a.credit_score = Math.max(0, Math.min(100, score));
    this.bus.emit("CreditScoreSet", CONTRACT, deployHash(), { agent_id, credit_score: a.credit_score });
  }

  /** Records realized x402 revenue + job completion + recomputes accuracy/dispute. */
  record_job(agent_id: string, revenue: RevenueEvent, accuracy_sample: number, disputed: boolean): void {
    const a = this.must(agent_id);
    a.x402_revenue_history.push(revenue);
    a.total_jobs_completed += 1;
    // Exponential moving average of accuracy keeps recent work weighted higher.
    a.accuracy_score = Math.round(a.accuracy_score * 0.7 + accuracy_sample * 0.3);
    const disputes = a.x402_revenue_history.length;
    const priorDisputed = Math.round(a.dispute_rate * (disputes - 1));
    a.dispute_rate = (priorDisputed + (disputed ? 1 : 0)) / disputes;
  }

  set_active(agent_id: string, active: boolean): void {
    this.must(agent_id).active = active;
  }

  /**
   * Demo seeding: backfill a prior 30-day track record so credit decisions are
   * realistic from the first run. In production this history accrues organically
   * from real x402 receipts.
   */
  seed_profile(
    agent_id: string,
    profile: Partial<Pick<Agent, "total_jobs_completed" | "accuracy_score" | "dispute_rate" | "reputation_score">> & {
      revenue_events?: RevenueEvent[];
    },
  ): void {
    const a = this.must(agent_id);
    if (profile.revenue_events) a.x402_revenue_history.push(...profile.revenue_events);
    if (profile.total_jobs_completed !== undefined) a.total_jobs_completed = profile.total_jobs_completed;
    if (profile.accuracy_score !== undefined) a.accuracy_score = profile.accuracy_score;
    if (profile.dispute_rate !== undefined) a.dispute_rate = profile.dispute_rate;
    if (profile.reputation_score !== undefined) a.reputation_score = profile.reputation_score;
  }

  get(agent_id: string): Agent | undefined {
    const a = this.agents.get(agent_id);
    return a ? { ...a, x402_revenue_history: [...a.x402_revenue_history] } : undefined;
  }

  /** Mutable internal handle — used only by other contracts within the ledger. */
  ref(agent_id: string): Agent {
    return this.must(agent_id);
  }

  list(): Agent[] {
    return [...this.agents.values()].map((a) => ({ ...a, x402_revenue_history: [...a.x402_revenue_history] }));
  }

  private must(agent_id: string): Agent {
    const a = this.agents.get(agent_id);
    if (!a) throw new Error(`unknown agent: ${agent_id}`);
    return a;
  }
}
