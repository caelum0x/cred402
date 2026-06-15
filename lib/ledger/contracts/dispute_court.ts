import type { Dispute, DisputeType, Verdict } from "../../core/protocol_types.js";
import { deployHash, shortId } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "DisputeCourt";

/**
 * DisputeCourt (p2 §6.9) — handles challenges against agents: bad evidence, fake
 * receipts, non-delivery, default, collusion, oracle manipulation. The
 * DisputeJudgeAgent assists but does not have unilateral authority; verdicts are
 * issued here and enforced via the SlashingVault.
 */
export class DisputeCourt {
  private readonly disputes = new Map<string, Dispute>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  open(args: {
    dispute_type: DisputeType;
    complainant: string;
    respondent_agent: string;
    receipt_id?: string;
    rwa_id?: string;
    note: string;
    evidence_hash: string;
  }): Dispute {
    const dispute: Dispute = {
      dispute_id: shortId("disp"),
      dispute_type: args.dispute_type,
      complainant: args.complainant,
      respondent_agent: args.respondent_agent,
      receipt_id: args.receipt_id,
      rwa_id: args.rwa_id,
      status: "opened",
      evidence: [
        { submitter: args.complainant, evidence_hash: args.evidence_hash, note: args.note, timestamp: this.clock.now() },
      ],
      slash_amount: 0n,
      rationale: [],
      opened_at: this.clock.now(),
    };
    this.disputes.set(dispute.dispute_id, dispute);
    this.bus.emit("DisputeOpened", CONTRACT, deployHash(), {
      dispute_id: dispute.dispute_id,
      dispute_type: dispute.dispute_type,
      respondent_agent: dispute.respondent_agent,
      complainant: dispute.complainant,
    });
    return { ...dispute };
  }

  submit_evidence(dispute_id: string, submitter: string, evidence_hash: string, note: string): void {
    const d = this.must(dispute_id);
    if (d.status === "resolved" || d.status === "closed") throw new Error("dispute already resolved");
    d.status = "evidence_period";
    d.evidence.push({ submitter, evidence_hash, note, timestamp: this.clock.now() });
    this.bus.emit("DisputeEvidenceSubmitted", CONTRACT, deployHash(), { dispute_id, submitter, evidence_hash });
  }

  /** Issue a verdict (called after the judge recommends + governance/arbiter confirms). */
  issue_verdict(dispute_id: string, verdict: Verdict, slash_amount: bigint, rationale: string[]): Dispute {
    const d = this.must(dispute_id);
    d.verdict = verdict;
    d.slash_amount = slash_amount;
    d.rationale = rationale;
    d.status = "resolved";
    d.resolved_at = this.clock.now();
    this.bus.emit("DisputeVerdictIssued", CONTRACT, deployHash(), {
      dispute_id,
      verdict,
      slash_amount: slash_amount.toString(),
      respondent_agent: d.respondent_agent,
    });
    return { ...d };
  }

  close(dispute_id: string): void {
    const d = this.must(dispute_id);
    d.status = "closed";
    this.bus.emit("DisputeClosed", CONTRACT, deployHash(), { dispute_id });
  }

  get(dispute_id: string): Dispute | undefined {
    const d = this.disputes.get(dispute_id);
    return d ? clone(d) : undefined;
  }

  forAgent(agent_id: string): Dispute[] {
    return this.list().filter((d) => d.respondent_agent === agent_id);
  }

  openCount(agent_id: string): number {
    return this.forAgent(agent_id).filter((d) => d.status !== "resolved" && d.status !== "closed").length;
  }

  list(): Dispute[] {
    return [...this.disputes.values()].map(clone);
  }

  private must(dispute_id: string): Dispute {
    const d = this.disputes.get(dispute_id);
    if (!d) throw new Error(`unknown dispute: ${dispute_id}`);
    return d;
  }
}

function clone(d: Dispute): Dispute {
  return { ...d, evidence: d.evidence.map((e) => ({ ...e })), rationale: [...d.rationale] };
}
