import type { Receipt } from "../core/types.js";
import type { Ledger } from "../ledger/ledger.js";

export interface FraudFlag {
  code: string;
  detail: string;
  weight: number; // contribution to the fraud score
}

export interface FraudReport {
  agent_id: string;
  score: number; // 0..100, higher = riskier
  flags: FraudFlag[];
  reciprocal_counterparties: string[];
  top_counterparty_share: number; // 0..1
  operator_swarm_size: number; // # of agents sharing this agent's operator
}

/**
 * FraudService (p4 §13 — Attack 1 "wash receipts" + Attack 2 "Sybil swarm") —
 * deterministic receipt-graph fraud detection. Catches collusion rings and
 * operator Sybils that mint fake x402 revenue to inflate credit. Signals:
 *
 *   - reciprocal loops      A↔B paying each other in a tight cycle (wash revenue)
 *   - operator linkage      payer and seller share an operator (self-dealing)
 *   - revenue concentration one counterparty dominates the agent's income
 *   - velocity anomaly      improbably many receipts in a short window
 *   - sybil operator swarm  one operator controls many agents (Attack 2)
 *   - pricing-band anomaly  receipts priced off-market vs. the service median
 *
 * The CreditAgent reads the score and penalizes or refuses credit; the
 * WatchdogAgent can escalate a `collusion` dispute when it crosses the threshold.
 */
export class FraudService {
  constructor(
    private readonly ledger: Ledger,
    private readonly windowSeconds = 60,
    private readonly velocityCap = 8,
    /** An operator controlling >= this many agents is flagged as a Sybil swarm. */
    private readonly sybilThreshold = 3,
    /** Receipts beyond [median/factor, median*factor] are off-market. */
    private readonly priceBandFactor = 3n,
  ) {}

  analyze(agent_id: string): FraudReport {
    const all = this.ledger.receipts.list();
    const asSeller = all.filter((r) => r.seller_agent === agent_id);
    const asPayer = all.filter((r) => r.payer_agent === agent_id);
    const flags: FraudFlag[] = [];

    // 1. Reciprocal loops: counterparties this agent both buys from and sells to.
    const sellers = new Set(asPayer.map((r) => r.seller_agent));
    const reciprocal = [...new Set(asSeller.map((r) => r.payer_agent))].filter((cp) => sellers.has(cp));
    if (reciprocal.length > 0) {
      flags.push({ code: "reciprocal_loop", detail: `mutual payments with ${reciprocal.join(", ")}`, weight: 35 });
    }

    // 2. Operator linkage: a counterparty sharing the same operator (wash trading).
    const myOperator = this.operatorOf(agent_id);
    const linked = [...new Set(asSeller.map((r) => r.payer_agent))].filter(
      (cp) => myOperator && this.operatorOf(cp) === myOperator,
    );
    if (linked.length > 0) {
      flags.push({ code: "operator_linkage", detail: `same operator as ${linked.join(", ")}`, weight: 40 });
    }

    // 3. Revenue concentration: one counterparty dominates income.
    const top_counterparty_share = this.topShare(asSeller);
    if (top_counterparty_share > 0.8 && asSeller.length >= 3) {
      flags.push({ code: "revenue_concentration", detail: `${(top_counterparty_share * 100).toFixed(0)}% from one payer`, weight: 20 });
    }

    // 4. Velocity anomaly: too many receipts in the rolling window.
    const velocity = this.maxVelocity(asSeller);
    if (velocity > this.velocityCap) {
      flags.push({ code: "velocity_anomaly", detail: `${velocity} receipts in ${this.windowSeconds}s`, weight: 15 });
    }

    // 5. Sybil operator swarm (Attack 2): one operator controlling many agents.
    const operator_swarm_size = this.operatorSwarmSize(agent_id);
    if (operator_swarm_size >= this.sybilThreshold) {
      flags.push({ code: "sybil_operator_swarm", detail: `operator controls ${operator_swarm_size} agents`, weight: 25 });
    }

    // 6. Pricing-band anomaly (Attack 1): receipts priced far off the service median.
    const offBand = this.pricingBandOutliers(asSeller);
    if (offBand.length > 0) {
      flags.push({ code: "pricing_band_anomaly", detail: `${offBand.length} receipt(s) priced off-market`, weight: 15 });
    }

    const score = Math.min(100, flags.reduce((s, f) => s + f.weight, 0));
    return { agent_id, score, flags, reciprocal_counterparties: reciprocal, top_counterparty_share, operator_swarm_size };
  }

  private operatorOf(agent_id: string): string | undefined {
    return this.ledger.buildPassport(agent_id)?.operator;
  }

  private topShare(receipts: Receipt[]): number {
    if (receipts.length === 0) return 0;
    const byPayer = new Map<string, bigint>();
    let total = 0n;
    for (const r of receipts) {
      byPayer.set(r.payer_agent, (byPayer.get(r.payer_agent) ?? 0n) + r.amount);
      total += r.amount;
    }
    if (total === 0n) return 0;
    const top = [...byPayer.values()].reduce((m, v) => (v > m ? v : m), 0n);
    return Number(top) / Number(total);
  }

  private maxVelocity(receipts: Receipt[]): number {
    const times = receipts.map((r) => r.timestamp).sort((a, b) => a - b);
    let max = 0;
    for (let i = 0; i < times.length; i++) {
      let j = i;
      while (j < times.length && times[j]! - times[i]! <= this.windowSeconds) j++;
      max = Math.max(max, j - i);
    }
    return max;
  }

  /** Number of agents (including this one) that share this agent's operator. */
  private operatorSwarmSize(agent_id: string): number {
    const op = this.operatorOf(agent_id);
    if (!op) return 1;
    return this.ledger.agents.list().filter((a) => this.operatorOf(a.agent_id) === op).length;
  }

  /**
   * Receipts whose amount sits outside the [median/factor, median*factor] band
   * for their service type — off-market pricing typical of fabricated revenue.
   * Only judged once a service type has enough global samples to form a band.
   */
  private pricingBandOutliers(asSeller: Receipt[]): Receipt[] {
    const byType = new Map<string, bigint[]>();
    for (const r of this.ledger.receipts.list()) {
      const arr = byType.get(r.service_type) ?? [];
      arr.push(r.amount);
      byType.set(r.service_type, arr);
    }
    const out: Receipt[] = [];
    for (const r of asSeller) {
      const amounts = byType.get(r.service_type) ?? [];
      if (amounts.length < 4) continue; // too few samples to establish a band
      const med = median(amounts);
      if (med === 0n) continue;
      const hi = med * this.priceBandFactor;
      const lo = med / this.priceBandFactor;
      if (r.amount > hi || r.amount < lo) out.push(r);
    }
    return out;
  }
}

/** Median of a list of bigints (lower-middle for even counts). */
function median(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}
