import type { Ledger } from "../lib/ledger/index.js";
import type { ChainEvent } from "../lib/core/types.js";
import type { EvidenceReport } from "./evidence_seller_agent.js";
import { DisputeJudgeAgent } from "./dispute_judge_agent.js";
import { cspr } from "../lib/core/units.js";
import { hashObject } from "../lib/core/hash.js";
import { fetchIndependentEnergyReading } from "../api/rwa_data/index.js";

export interface Alert {
  level: "info" | "warn" | "critical";
  message: string;
  timestamp: number;
}

/**
 * WatchdogAgent — accountability. It subscribes to Casper streaming events and
 * reacts in real time: cross-checking evidence against an independent data
 * source, detecting missed repayments, opening disputes, slashing stake,
 * freezing credit lines and downgrading reputation.
 */
export class WatchdogAgent {
  readonly alerts: Alert[] = [];
  private unsubscribe?: () => void;
  private readonly judge: DisputeJudgeAgent;

  constructor(
    private readonly ledger: Ledger,
    private readonly maxDeviationPct = 15,
  ) {
    this.judge = new DisputeJudgeAgent(ledger);
  }

  /** Begin listening to the event stream. */
  start(): void {
    this.unsubscribe = this.ledger.bus.subscribe((e) => this.onEvent(e));
    this.alert("info", "WatchdogAgent online — subscribed to Casper streaming events");
  }

  stop(): void {
    this.unsubscribe?.();
  }

  private onEvent(e: ChainEvent): void {
    if (e.name === "ReceiptDisputed") {
      this.alert("critical", `dispute opened on receipt ${e.data.receipt_id}`);
    } else if (e.name === "StakeSlashed") {
      this.alert("critical", `stake slashed for ${e.data.agent_id} (${e.data.amount} motes)`);
    } else if (e.name === "CreditFrozen") {
      this.alert("warn", `credit line frozen for ${e.data.agent_id}: ${e.data.reason}`);
    }
  }

  /**
   * Cross-check an energy report against an independent reading. If the reported
   * output deviates beyond tolerance, escalate to a dispute + slashing.
   */
  async auditEnergyReport(report: EvidenceReport, receipt_id: string): Promise<boolean> {
    if (report.evidence_type !== "energy_output") return false;
    const measured = Number((report.fields as { measured_kwh?: number }).measured_kwh ?? 0);
    const independent = await fetchIndependentEnergyReading();
    const deviationPct = Math.abs((measured - independent) / independent) * 100;

    this.alert(
      "info",
      `cross-checked ${report.seller_agent}: reported ${measured} kWh vs independent ${independent} kWh (${deviationPct.toFixed(1)}% deviation)`,
    );

    if (deviationPct > this.maxDeviationPct) {
      await this.escalateDispute({
        receipt_id,
        report,
        deviationPct,
      });
      return true;
    }
    return false;
  }

  /**
   * Full dispute lifecycle (p2 §6.9–6.10): open a DisputeCourt case, let the
   * DisputeJudgeAgent investigate, issue the verdict on-chain, then enforce —
   * dispute the receipt, slash stake into the SlashingVault, freeze credit and
   * downgrade reputation in proportion to the verdict.
   */
  async escalateDispute(args: { receipt_id: string; report: EvidenceReport; deviationPct: number }): Promise<void> {
    const seller_agent = args.report.seller_agent;
    const dispute_hash = hashObject({
      receipt_id: args.receipt_id,
      reason: "energy_output deviation",
      deviationPct: args.deviationPct,
    });

    // 1. Open the dispute.
    const dispute = this.ledger.disputes.open({
      dispute_type: "bad_evidence",
      complainant: "WatchdogAgent",
      respondent_agent: seller_agent,
      receipt_id: args.receipt_id,
      rwa_id: args.report.rwa_id,
      note: `cross-check deviation ${args.deviationPct.toFixed(1)}%`,
      evidence_hash: dispute_hash,
    });

    // 2. Judge investigates and recommends.
    const rec = await this.judge.investigate(dispute, { report: args.report });

    // 3. Court issues the verdict.
    this.ledger.disputes.issue_verdict(dispute.dispute_id, rec.verdict, rec.slash_amount, rec.rationale);

    // 4. Enforce, if the agent is at fault.
    if (rec.verdict === "agent_loses" || rec.verdict === "partial_fault") {
      this.ledger.receipts.dispute_receipt(args.receipt_id, dispute_hash);
      this.ledger.agents.slash(seller_agent, rec.slash_amount, dispute_hash);
      this.ledger.slashing.apply_slash({
        agent_id: seller_agent,
        amount: rec.slash_amount,
        reason: `dispute ${dispute.dispute_id}: ${rec.verdict}`,
        dispute_id: dispute.dispute_id,
      });
      this.ledger.pool.freeze(seller_agent, "evidence dispute");
      const repDrop = rec.verdict === "agent_loses" ? -25 : -10;
      this.ledger.agents.update_reputation(seller_agent, repDrop, dispute_hash, "BAD_EVIDENCE_VERDICT");
      this.alert("critical", `${rec.verdict}: slashed + froze ${seller_agent} for falsified RWA evidence`);
    } else {
      this.alert("info", `dispute ${dispute.dispute_id} verdict ${rec.verdict} — no penalty`);
    }
    this.ledger.disputes.close(dispute.dispute_id);
  }

  /** Detect and act on missed repayments across all credit lines. */
  async monitorRepayments(): Promise<void> {
    for (const line of this.ledger.pool.list()) {
      if (this.ledger.pool.isOverdue(line.agent_id) && line.status === "active") {
        const reason_hash = hashObject({ reason: "default", agent: line.agent_id });
        const dispute = this.ledger.disputes.open({
          dispute_type: "agent_default",
          complainant: "WatchdogAgent",
          respondent_agent: line.agent_id,
          note: "missed repayment past due",
          evidence_hash: reason_hash,
        });
        const rec = await this.judge.investigate(dispute, {});
        this.ledger.disputes.issue_verdict(dispute.dispute_id, rec.verdict, rec.slash_amount, rec.rationale);
        const loss = this.ledger.pool.liquidate(line.agent_id);
        this.ledger.agents.slash(line.agent_id, rec.slash_amount, reason_hash);
        this.ledger.slashing.apply_slash({
          agent_id: line.agent_id,
          amount: rec.slash_amount,
          reason: `default ${dispute.dispute_id}`,
          dispute_id: dispute.dispute_id,
          split: { insurance_reserve: 0.7, protocol_treasury: 0.3 },
        });
        this.ledger.agents.update_reputation(line.agent_id, -40, reason_hash, "CREDIT_DEFAULT");
        this.ledger.disputes.close(dispute.dispute_id);
        this.alert("critical", `agent ${line.agent_id} defaulted (${loss} motes) — liquidated and slashed`);
      }
    }
  }

  private alert(level: Alert["level"], message: string): void {
    this.alerts.push({ level, message, timestamp: this.ledger.clock.now() });
  }
}
