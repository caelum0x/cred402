import type { Ledger } from "../lib/ledger/index.js";
import type { CreditLine, Evidence, RiskResult, RwaJob } from "../lib/core/types.js";
import type { CreditDecision } from "../lib/core/risk_policy.js";
import { scaleMotes } from "../lib/core/units.js";
import { FraudService } from "../lib/services/fraud_service.js";
import { reasonCodesFromInputs } from "../lib/core/reason_codes.js";
import { realfiCreditSignal } from "../lib/services/realfi_credit.js";
import { ComplianceService } from "../lib/compliance/service.js";
import { computeTier } from "../lib/services/reputation_tiers.js";

/**
 * CreditAgent — the underwriter. It reads an agent's x402 receipt history, runs
 * the active RiskPolicyManager policy to compute a credit score and revolving
 * credit line, writes the score on-chain, and opens the line in the pool.
 *
 * It also scores RWA jobs: aggregating the submitted evidence into a recommended
 * loan-to-value the TreasuryAgent acts on.
 */
export class CreditAgent {
  private readonly fraud: FraudService;
  private readonly compliance: ComplianceService;
  constructor(private readonly ledger: Ledger) {
    this.fraud = new FraudService(ledger);
    this.compliance = new ComplianceService(ledger);
  }

  /** Underwrite an agent and open/update its credit line, subject to governance. */
  underwrite(agent_id: string, opts: { term_days?: number } = {}): { decision: CreditDecision; line: CreditLine } {
    const agent = this.ledger.agents.get(agent_id);
    if (!agent) throw new Error(`unknown agent: ${agent_id}`);

    const gov = this.ledger.governance.get();
    // Invariant (p2 §6.7): agent below minimum reputation cannot be underwritten.
    if (agent.reputation_score < gov.min_reputation_to_draw) {
      throw new Error(
        `reputation ${agent.reputation_score} below governance minimum ${gov.min_reputation_to_draw}`,
      );
    }
    // Invariant: an agent with an open severe dispute cannot get fresh credit.
    if (this.ledger.disputes.openCount(agent_id) > 0) {
      throw new Error(`agent ${agent_id} has an open dispute`);
    }

    // Compliance gate (p2 §7.9): refuse sanctioned/blocked operators outright.
    const screen = this.compliance.screenAgent(agent_id);
    if (!screen.cleared) {
      throw new Error(`compliance check failed: ${screen.blocking_reason}`);
    }

    // Fraud screen (p2 §7.8): refuse on high collusion risk, else penalize.
    const fraud = this.fraud.analyze(agent_id);
    if (fraud.score >= 70) {
      throw new Error(`fraud risk too high (${fraud.score}): ${fraud.flags.map((f) => f.code).join(", ")}`);
    }
    const fraudFactor = Math.max(0.3, 1 - fraud.score / 100);

    const decision = this.ledger.policy.evaluate(agent);
    this.ledger.agents.set_credit_score(agent_id, decision.credit_score);
    if (fraud.flags.length > 0) {
      decision.rationale.push(`fraud penalty x${fraudFactor.toFixed(2)} (${fraud.flags.map((f) => f.code).join(", ")})`);
    }

    // Apply fraud penalty, then cap exposure to governance max_agent_exposure.
    const penalized = scaleMotes(decision.credit_line, fraudFactor);
    const fraudCapped = penalized > gov.max_agent_exposure ? gov.max_agent_exposure : penalized;

    // RealFi uplift/penalty (p6 §864) — bounded so fiat never dominates the line.
    const operator_id = this.ledger.buildPassport(agent_id)?.operator;
    const realfi = realfiCreditSignal(this.ledger, agent_id, operator_id);
    const realfiAdjusted = scaleMotes(fraudCapped, realfi.multiplier);
    // Reputation-tier perk: higher tiers get a real credit-capacity multiplier.
    const tier = computeTier(this.ledger, agent_id);
    const tierMult = "tier" in tier ? tier.credit_multiplier : 1;
    if ("tier" in tier && tierMult !== 1) decision.rationale.push(`${tier.tier} tier perk x${tierMult.toFixed(2)}`);
    const tierAdjusted = scaleMotes(realfiAdjusted, tierMult);
    const capped = tierAdjusted > gov.max_agent_exposure ? gov.max_agent_exposure : tierAdjusted;
    if (realfi.multiplier !== 1.0) {
      decision.rationale.push(`realfi factor x${realfi.multiplier.toFixed(2)} (operator/fiat/bank signals)`);
    }

    // Structured reason codes (p5 §15) — derived from real on-chain signals.
    const existing = this.ledger.pool.get(agent_id);
    decision.reason_codes = [
      ...reasonCodesFromInputs({
        agent,
        finalizedReceiptCount: this.ledger.receipts.forSeller(agent_id).filter((r) => r.status === "finalized").length,
        verifiedEvidenceCount: this.ledger.evidence.list().filter((e) => e.agent_id === agent_id && e.verified).length,
        repaymentCount: this.ledger.bus.all().filter((e) => e.name === "CreditRepaid" && (e.data as { agent_id?: string }).agent_id === agent_id).length,
        topCounterpartyShare: fraud.top_counterparty_share,
        suspiciousFraudFlags: fraud.flags.map((f) => f.code),
        creditLine: capped,
        overdue: existing !== undefined && existing.drawn > 0n && existing.due_timestamp < this.ledger.clock.now(),
        badEvidenceVerdict: this.ledger.disputes.forAgent(agent_id).some((d) => d.verdict === "agent_loses"),
      }),
      ...realfi.reason_codes,
    ];

    const line = this.ledger.pool.open_credit_line({
      agent_id,
      max_credit: capped,
      interest_rate_bps: decision.interest_rate_bps,
      origination_fee_bps: gov.origination_fee_bps,
      term_seconds: (opts.term_days ?? 7) * 24 * 60 * 60,
    });

    return { decision, line };
  }

  /**
   * Read-only credit explanation (p5 §15): compute the decision + structured
   * reason codes + RealFi factor WITHOUT opening a line or mutating state. Powers
   * the console's "explain this score" view and the `/api/credit/explain` route.
   */
  explain(agent_id: string): {
    decision: CreditDecision;
    fraud_score: number;
    realfi_multiplier: number;
    eligible: boolean;
    ineligible_reason?: string;
  } | { error: string } {
    const agent = this.ledger.agents.get(agent_id);
    if (!agent) return { error: `unknown agent: ${agent_id}` };
    const gov = this.ledger.governance.get();
    const fraud = this.fraud.analyze(agent_id);
    const decision = this.ledger.policy.evaluate(agent);

    let eligible = true;
    let ineligible_reason: string | undefined;
    if (agent.reputation_score < gov.min_reputation_to_draw) {
      eligible = false;
      ineligible_reason = `reputation ${agent.reputation_score} below minimum ${gov.min_reputation_to_draw}`;
    } else if (this.ledger.disputes.openCount(agent_id) > 0) {
      eligible = false;
      ineligible_reason = "open dispute";
    } else if (fraud.score >= 70) {
      eligible = false;
      ineligible_reason = `fraud risk too high (${fraud.score})`;
    } else {
      const screen = this.compliance.screenAgent(agent_id);
      if (!screen.cleared) {
        eligible = false;
        ineligible_reason = `compliance: ${screen.blocking_reason}`;
      }
    }

    const fraudFactor = Math.max(0.3, 1 - fraud.score / 100);
    const fraudCapped = scaleMotes(decision.credit_line, fraudFactor);
    const operator_id = this.ledger.buildPassport(agent_id)?.operator;
    const realfi = realfiCreditSignal(this.ledger, agent_id, operator_id);
    const realfiProjected = scaleMotes(fraudCapped, realfi.multiplier);
    const tier = computeTier(this.ledger, agent_id);
    const projected = scaleMotes(realfiProjected, "tier" in tier ? tier.credit_multiplier : 1);
    const capped = projected > gov.max_agent_exposure ? gov.max_agent_exposure : projected;
    decision.credit_line = capped;

    const existing = this.ledger.pool.get(agent_id);
    decision.reason_codes = [
      ...reasonCodesFromInputs({
        agent,
        finalizedReceiptCount: this.ledger.receipts.forSeller(agent_id).filter((r) => r.status === "finalized").length,
        verifiedEvidenceCount: this.ledger.evidence.list().filter((e) => e.agent_id === agent_id && e.verified).length,
        repaymentCount: this.ledger.bus.all().filter((e) => e.name === "CreditRepaid" && (e.data as { agent_id?: string }).agent_id === agent_id).length,
        topCounterpartyShare: fraud.top_counterparty_share,
        suspiciousFraudFlags: fraud.flags.map((f) => f.code),
        creditLine: capped,
        overdue: existing !== undefined && existing.drawn > 0n && existing.due_timestamp < this.ledger.clock.now(),
        badEvidenceVerdict: this.ledger.disputes.forAgent(agent_id).some((d) => d.verdict === "agent_loses"),
      }),
      ...realfi.reason_codes,
    ];
    return { decision, fraud_score: fraud.score, realfi_multiplier: realfi.multiplier, eligible, ineligible_reason };
  }

  /**
   * Score an RWA job from its on-chain evidence. Aggregates confidence and the
   * energy/weather/receivable signals into a recommended max LTV and an approval.
   */
  scoreRwaJob(rwa_id: string): RwaJob {
    const job = this.ledger.jobs.get(rwa_id);
    if (!job) throw new Error(`unknown rwa job: ${rwa_id}`);
    const evidence = this.ledger.evidence.forRwa(rwa_id).filter((e) => e.verified);

    const rationale: string[] = [];
    const ltv = this.recommendLtv(evidence, rationale);
    const approved = evidence.length >= job.needed_evidence.length && ltv >= 0.4;
    const approved_amount = approved
      ? minBig(job.requested_loan, scaleMotes(job.requested_loan, ltv))
      : 0n;

    if (approved) rationale.push(`approved up to ${(ltv * 100).toFixed(0)}% LTV`);
    else rationale.push(`insufficient verified evidence or LTV below floor`);

    const result: RiskResult = {
      recommended_max_ltv: ltv,
      approved,
      approved_amount,
      rationale,
    };
    return this.ledger.jobs.score(rwa_id, result);
  }

  private recommendLtv(evidence: Evidence[], rationale: string[]): number {
    if (evidence.length === 0) {
      rationale.push("no verified evidence");
      return 0;
    }
    const avgConfidence = evidence.reduce((s, e) => s + e.confidence, 0) / evidence.length;
    rationale.push(`avg verified evidence confidence ${avgConfidence.toFixed(0)}/100`);
    // Map 0..100 confidence onto a conservative 0..0.7 LTV band.
    const ltv = Math.min(0.7, (avgConfidence / 100) * 0.72);
    return Math.round(ltv * 100) / 100;
  }
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
