import { Ledger } from "../lib/ledger/index.js";
import { BuyerAgent } from "./buyer_agent.js";
import { EvidenceSellerAgent, type EvidenceReport } from "./evidence_seller_agent.js";
import { CreditAgent } from "./credit_agent.js";
import { TreasuryAgent } from "./treasury_agent.js";
import { WatchdogAgent } from "./watchdog_agent.js";
import { LiquidityRouterAgent } from "./liquidity_router_agent.js";
import type { RevenueEvent } from "../lib/core/types.js";
import { cspr, formatCspr } from "../lib/core/units.js";
import { hashObject } from "../lib/core/hash.js";
import { SOLAR_A17 } from "../api/rwa_data/index.js";

export interface StepLog {
  scene: string;
  lines: string[];
}

/**
 * Cred402Economy — wires the full agent fleet onto one ledger and runs the
 * magic loop. Shared by the CLI demo (`scripts/run_demo_flow.ts`) and the API
 * server's `/api/demo/run` trigger so the dashboard and terminal show identical
 * on-chain state.
 */
export class Cred402Economy {
  readonly buyer: BuyerAgent;
  readonly seller: EvidenceSellerAgent;
  readonly credit: CreditAgent;
  readonly treasury: TreasuryAgent;
  readonly watchdog: WatchdogAgent;
  readonly router: LiquidityRouterAgent;

  constructor(readonly ledger: Ledger = new Ledger()) {
    this.buyer = new BuyerAgent(ledger);
    this.seller = new EvidenceSellerAgent(ledger);
    this.credit = new CreditAgent(ledger);
    this.treasury = new TreasuryAgent(ledger);
    this.watchdog = new WatchdogAgent(ledger);
    this.router = new LiquidityRouterAgent(ledger);
    this.watchdog.start();
  }

  /** Seed the seller's 30-day x402 track record + pool liquidity + stake. */
  bootstrap(): StepLog {
    const lines: string[] = [];
    // Seller stakes collateral (gives it skin in the game).
    this.seller.stake(50);
    lines.push(`${this.seller.agent_id} staked 50 CSPR collateral`);

    // Backfill a believable 30-day revenue history (~128 CSPR over 410 jobs).
    const now = this.ledger.clock.now();
    const revenue_events: RevenueEvent[] = [];
    for (let i = 0; i < 410; i++) {
      revenue_events.push({
        receipt_id: `seed-${i}`,
        amount: cspr(0.31), // ~128 CSPR total
        timestamp: now - Math.floor((i / 410) * 29 * 24 * 60 * 60),
        service_type: "solar_output_verification",
      });
    }
    this.ledger.agents.seed_profile(this.seller.agent_id, {
      revenue_events,
      total_jobs_completed: 412,
      accuracy_score: 94,
      dispute_rate: 0.017,
      reputation_score: 91,
    });
    lines.push(`seeded 30-day history: 412 jobs, 94/100 accuracy, 1.7% dispute rate`);

    // Agent Passport profile (p2 Product A): capabilities, spending limit, operator.
    // Distinct operators: the evidence vendor and the RWA protocol are independent
    // parties (shared operators would correctly trip the FraudService linkage check).
    this.ledger.passports.set_profile(this.seller.agent_id, {
      capabilities: ["rwa.energy.production_verification", "x402.sell", "evidence.submit"],
      spending_limit: cspr(20),
      operator: "evidence.vendor.operator",
    });
    this.ledger.passports.set_profile(this.buyer.agent_id, {
      capabilities: ["rwa.request", "x402.pay", "credit.request"],
      spending_limit: cspr(50),
      operator: "rwa.protocol.operator",
    });

    // Treasury LPs seed the credit pool.
    this.treasury.depositLiquidity(1000);
    lines.push(`TreasuryAgent deposited 1,000 CSPR liquidity into AgentCreditPool`);
    return { scene: "Bootstrap", lines };
  }

  /** Scene 1 — register the RWA asset, then the RWA protocol posts a job. */
  createJob(): StepLog {
    // Register the canonical asset in the RWAAssetRegistry (p2 §6.4) once.
    if (!this.ledger.assets.get(SOLAR_A17.rwa_id)) {
      this.ledger.assets.register_asset({
        rwa_id: SOLAR_A17.rwa_id,
        asset_type: "solar_receivable",
        issuer: "SPV-A17",
        jurisdiction_code: "TR",
        metadata_hash: hashObject({ ...SOLAR_A17 }),
        document_bundle_hash: hashObject({ docs: ["ppa", "insurance", "meter_calibration"] }),
      });
    }
    const job = this.buyer.createSolarJob();
    return {
      scene: "An RWA needs evidence",
      lines: [
        `registered asset ${SOLAR_A17.rwa_id} (solar_receivable, jurisdiction TR)`,
        `${this.buyer.agent_id} created job ${job.rwa_id} (${job.name})`,
        `requested loan: ${formatCspr(job.requested_loan)} CSPR test units`,
        `needed evidence: ${job.needed_evidence.join(", ")}`,
      ],
    };
  }

  /** Scenes 2-4 — the agent buys each evidence over x402 and earns reputation. */
  async runEvidencePurchases(opts: { tamperEnergy?: boolean } = {}): Promise<{ log: StepLog; reports: EvidenceReport[] }> {
    const lines: string[] = [];
    const reports: EvidenceReport[] = [];
    const rwa_id = "SOLAR-A17";
    const bounty = cspr(0.002);

    for (const evidence_type of ["energy_output", "weather_risk", "receivable_quality"]) {
      const tampered = opts.tamperEnergy && evidence_type === "energy_output";
      const result = await this.buyer.buyEvidence(this.seller, rwa_id, evidence_type, bounty, { tampered });
      reports.push(result.report);
      lines.push(
        `x402 ${evidence_type}: 402 → paid ${result.challenge_headers["X-Payment-Amount"]} CSPR → receipt ${result.receipt.receipt_id}`,
      );
      lines.push(`   evidence_hash ${result.report.evidence_hash.slice(0, 18)}…  result_hash ${result.report.result_hash.slice(0, 18)}…`);
    }
    this.ledger.jobs.mark_evidence_complete(rwa_id);
    return { log: { scene: "Autonomous agent buys data & submits evidence", lines }, reports };
  }

  /** Watchdog cross-checks the energy report against an independent source. */
  async runWatchdogAudit(reports: EvidenceReport[]): Promise<{ log: StepLog; disputed: boolean }> {
    const energy = reports.find((r) => r.evidence_type === "energy_output");
    let disputed = false;
    const lines: string[] = [];
    if (energy) {
      const receipts = this.ledger.receipts.forSeller(this.seller.agent_id);
      const linked = receipts.find((r) => r.result_hash === energy.result_hash);
      disputed = await this.watchdog.auditEnergyReport(energy, linked?.receipt_id ?? "");
    }
    for (const a of this.watchdog.alerts.slice(-3)) lines.push(`[${a.level}] ${a.message}`);
    return { log: { scene: "Watchdog cross-checks evidence", lines }, disputed };
  }

  /** Scene — score the RWA job into a recommended LTV. */
  scoreJob(): StepLog {
    const job = this.credit.scoreRwaJob("SOLAR-A17");
    const r = job.risk_result!;
    return {
      scene: "RWA job scored",
      lines: [
        `recommended max LTV: ${(r.recommended_max_ltv * 100).toFixed(0)}%`,
        `decision: ${r.approved ? "APPROVE" : "REJECT"} (${formatCspr(r.approved_amount)} CSPR)`,
        ...r.rationale.map((x) => `   • ${x}`),
      ],
    };
  }

  /** Scene 5 — underwrite the seller and open a DeFi credit line. */
  underwriteSeller(): { log: StepLog; creditLineMotes: bigint } {
    const { decision, line } = this.credit.underwrite(this.seller.agent_id);
    const reasons = (decision.reason_codes ?? []).map(
      (c) => `   ${c.polarity === "positive" ? "+" : "−"} ${c.code}: ${c.detail}`,
    );
    return {
      log: {
        scene: "Agent receives a DeFi credit line",
        lines: [
          `policy ${decision.policy_version}: 30-day revenue ${formatCspr(decision.last_30_day_revenue)} CSPR`,
          `credit score ${decision.credit_score}/100 → APR ${(decision.interest_rate_bps / 100).toFixed(1)}%`,
          `approved credit line: ${formatCspr(line.max_credit)} CSPR`,
          `reason codes (p5 §15):`,
          ...reasons,
        ],
      },
      creditLineMotes: line.max_credit,
    };
  }

  /** Scene 6 — agent draws working capital. */
  drawCredit(amountCspr: number): StepLog {
    const line = this.treasury.fundDraw(this.seller.agent_id, amountCspr);
    return {
      scene: "Agent draws working capital",
      lines: [
        `${this.seller.agent_id} drew ${amountCspr} CSPR (purpose: future data purchases)`,
        `drawn ${formatCspr(line.drawn)} / ${formatCspr(line.max_credit)} CSPR, due in 7 days`,
      ],
    };
  }

  /** Optional repayment to show the full credit cycle + LP yield. */
  repay(amountCspr: number): StepLog {
    const { interest } = this.treasury.collectRepayment(this.seller.agent_id, amountCspr);
    return {
      scene: "Agent repays + LPs earn yield",
      lines: [`repaid ${amountCspr} CSPR (interest to pool: ${formatCspr(interest)} CSPR)`],
    };
  }

  /** Recompute multi-dimensional reputation (p2 §6.6) and write it on-chain. */
  applyReputationEngine(): StepLog {
    const agent = this.ledger.agents.get(this.seller.agent_id)!;
    const { dimensions, score } = this.ledger.reputation.compute(agent, {
      open_disputes: this.ledger.disputes.openCount(agent.agent_id),
      repayments_on_time: 1,
      repayments_total: 1,
    });
    const delta = score - agent.reputation_score;
    this.ledger.agents.update_reputation(agent.agent_id, delta, hashObject({ source: "ReputationEngine", dimensions }));
    return {
      scene: "ReputationEngine recomputes trust",
      lines: [
        `quality ${dimensions.quality_score} · dispute ${dimensions.dispute_score} · revenue ${dimensions.revenue_score} · repayment ${dimensions.repayment_score}`,
        `composite reputation → ${score}/100`,
      ],
    };
  }

  /** LiquidityRouterAgent assesses pool utilization (p2 §8.1). */
  routeLiquidity(): StepLog {
    const action = this.router.evaluate();
    return { scene: "LiquidityRouter assesses the pool", lines: [`${action.recommendation}: ${action.note}`] };
  }
}
