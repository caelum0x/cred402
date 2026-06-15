import type { RiskResult, RwaJob } from "../../core/types.js";
import { deployHash, shortId } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "RWAJobBoard";

/**
 * RWAJobBoard — the demand side. RWA protocols post verification jobs (a tokenized
 * solar farm seeking a credit line) with a per-evidence x402 bounty. Agents earn
 * by fulfilling the needed evidence. Part of the RWAEvidenceRegistry surface.
 */
export class RWAJobBoard {
  private readonly jobs = new Map<string, RwaJob>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  create_job(job: Omit<RwaJob, "rwa_id" | "status" | "created_at"> & { rwa_id?: string }): RwaJob {
    const rwa_id = job.rwa_id ?? shortId("SOLAR");
    const full: RwaJob = {
      ...job,
      rwa_id,
      status: "open",
      created_at: this.clock.now(),
    };
    this.jobs.set(rwa_id, full);
    this.bus.emit("RwaJobCreated", CONTRACT, deployHash(), {
      rwa_id,
      name: full.name,
      requested_loan: full.requested_loan.toString(),
      needed_evidence: full.needed_evidence,
    });
    return { ...full };
  }

  mark_evidence_complete(rwa_id: string): void {
    const j = this.must(rwa_id);
    if (j.status === "open") j.status = "evidence_complete";
  }

  score(rwa_id: string, result: RiskResult): RwaJob {
    const j = this.must(rwa_id);
    j.risk_result = result;
    j.status = result.approved ? "funded" : "rejected";
    this.bus.emit("RwaJobScored", CONTRACT, deployHash(), {
      rwa_id,
      approved: result.approved,
      recommended_max_ltv: result.recommended_max_ltv,
      approved_amount: result.approved_amount.toString(),
    });
    return { ...j };
  }

  get(rwa_id: string): RwaJob | undefined {
    const j = this.jobs.get(rwa_id);
    return j ? { ...j } : undefined;
  }

  list(): RwaJob[] {
    return [...this.jobs.values()].map((j) => ({ ...j }));
  }

  private must(rwa_id: string): RwaJob {
    const j = this.jobs.get(rwa_id);
    if (!j) throw new Error(`unknown rwa job: ${rwa_id}`);
    return j;
  }
}
