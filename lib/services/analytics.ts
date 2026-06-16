import type { Ledger } from "../ledger/ledger.js";
import { FraudService } from "./fraud_service.js";
import { computeTier } from "./reputation_tiers.js";

/**
 * Protocol analytics — the numbers a founder/LP/agent actually watches.
 *
 * Computed live from the canonical ledger + event stream: TVL and utilization,
 * an agent leaderboard, x402 throughput, evidence quality, dispute/fraud health,
 * and a credit-flow timeline reconstructed from emitted events. No external
 * warehouse needed — this is the read-model the console's Analytics page renders.
 */

export interface AgentLeaderRow {
  agent_id: string;
  service_type: string;
  reputation: number;
  credit_score: number;
  revenue_motes: string;
  receipts: number;
  credit_line_motes: string;
  fraud_score: number;
  tier: string;
}

export interface TimelinePoint {
  seq: number;
  event: string;
  agent_id?: string;
  amount_motes?: string;
}

export interface AnalyticsView {
  generated_at: number;
  totals: {
    agents: number;
    receipts: number;
    finalized_receipts: number;
    evidence: number;
    verified_evidence: number;
    rwa_assets: number;
    disputes: number;
    open_disputes: number;
    fiat_receipts: number;
  };
  pool: {
    tvl_motes: string;
    outstanding_motes: string;
    interest_accrued_motes: string;
    utilization: number;
    open_credit_lines: number;
    defaults: number;
  };
  x402: {
    total_volume_motes: string;
    avg_receipt_motes: string;
    settled_rate: number;
  };
  risk: {
    avg_reputation: number;
    avg_credit_score: number;
    high_fraud_agents: number;
    avg_dispute_rate: number;
  };
  leaderboard: AgentLeaderRow[];
  credit_timeline: TimelinePoint[];
}

const CREDIT_EVENTS = new Set(["CreditLineOpened", "CreditDrawn", "CreditRepaid", "CreditFrozen", "CreditDefaulted"]);

export class AnalyticsService {
  private readonly fraud: FraudService;
  constructor(private readonly ledger: Ledger) {
    this.fraud = new FraudService(ledger);
  }

  compute(): AnalyticsView {
    const agents = this.ledger.agents.list();
    const receipts = this.ledger.receipts.list();
    const evidence = this.ledger.evidence.list();
    const pool = this.ledger.pool.poolState();
    const lines = this.ledger.pool.list();

    const totalVolume = receipts.reduce((s, r) => s + r.amount, 0n);
    const finalized = receipts.filter((r) => r.status === "finalized");
    const settled = receipts.filter((r) => r.status === "settled" || r.status === "finalized");

    const leaderboard: AgentLeaderRow[] = agents
      .map((a) => {
        const revenue = a.x402_revenue_history.reduce((s, e) => s + e.amount, 0n);
        return {
          agent_id: a.agent_id,
          service_type: a.service_type,
          reputation: a.reputation_score,
          credit_score: a.credit_score,
          revenue_motes: revenue.toString(),
          receipts: receipts.filter((r) => r.seller_agent === a.agent_id).length,
          credit_line_motes: (this.ledger.pool.get(a.agent_id)?.max_credit ?? 0n).toString(),
          fraud_score: this.fraud.analyze(a.agent_id).score,
          tier: (() => { const t = computeTier(this.ledger, a.agent_id); return "tier" in t ? t.tier : "unrated"; })(),
        };
      })
      .sort((x, y) => BigInt(y.revenue_motes) > BigInt(x.revenue_motes) ? 1 : -1);

    const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, n) => s + n, 0) / xs.length) : 0);
    const utilization = Number(pool.total_liquidity) > 0 ? Number(pool.outstanding_credit) / Number(pool.total_liquidity) : 0;

    const credit_timeline: TimelinePoint[] = this.ledger.bus
      .all()
      .filter((e) => CREDIT_EVENTS.has(e.name))
      .slice(-50)
      .map((e) => ({
        seq: e.seq,
        event: e.name,
        agent_id: (e.data as { agent_id?: string }).agent_id,
        amount_motes: (e.data as { amount?: string }).amount,
      }));

    return {
      generated_at: this.ledger.clock.now(),
      totals: {
        agents: agents.length,
        receipts: receipts.length,
        finalized_receipts: finalized.length,
        evidence: evidence.length,
        verified_evidence: evidence.filter((e) => e.verified).length,
        rwa_assets: this.ledger.assets.list().length,
        disputes: this.ledger.disputes.list().length,
        open_disputes: this.ledger.disputes.list().filter((d) => d.status !== "resolved" && d.status !== "closed").length,
        fiat_receipts: this.ledger.fiatReceipts.list().length,
      },
      pool: {
        tvl_motes: pool.total_liquidity.toString(),
        outstanding_motes: pool.outstanding_credit.toString(),
        interest_accrued_motes: pool.interest_accrued.toString(),
        utilization,
        open_credit_lines: lines.length,
        defaults: pool.defaults,
      },
      x402: {
        total_volume_motes: totalVolume.toString(),
        avg_receipt_motes: (receipts.length ? totalVolume / BigInt(receipts.length) : 0n).toString(),
        settled_rate: receipts.length ? settled.length / receipts.length : 0,
      },
      risk: {
        avg_reputation: avg(agents.map((a) => a.reputation_score)),
        avg_credit_score: avg(agents.map((a) => a.credit_score)),
        high_fraud_agents: leaderboard.filter((r) => r.fraud_score >= 70).length,
        avg_dispute_rate: agents.length ? agents.reduce((s, a) => s + a.dispute_rate, 0) / agents.length : 0,
      },
      leaderboard,
      credit_timeline,
    };
  }
}
