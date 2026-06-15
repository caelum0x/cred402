import type { Ledger } from "../lib/ledger/index.js";
import type { Dispute, Verdict } from "../lib/core/protocol_types.js";
import { cspr } from "../lib/core/units.js";
import { fetchIndependentEnergyReading } from "../api/rwa_data/index.js";
import type { EvidenceReport } from "./evidence_seller_agent.js";

export interface VerdictRecommendation {
  verdict: Verdict;
  slash_amount: bigint;
  rationale: string[];
  confidence: number; // 0..100
}

/**
 * DisputeJudgeAgent (p2 §8.1) — assists dispute resolution. It summarizes the
 * evidence, compares source hashes, detects contradictions and recommends an
 * explainable verdict. It has NO unilateral authority: it returns a
 * recommendation that the DisputeCourt (governance/arbiter) issues.
 */
export class DisputeJudgeAgent {
  constructor(private readonly ledger: Ledger) {}

  /**
   * Investigate a dispute. For energy_output disputes it cross-checks the claimed
   * reading against an independent source; the larger the deviation, the stronger
   * the recommendation against the agent.
   */
  async investigate(dispute: Dispute, context: { report?: EvidenceReport }): Promise<VerdictRecommendation> {
    const rationale: string[] = [];
    rationale.push(`dispute_type=${dispute.dispute_type}, respondent=${dispute.respondent_agent}`);
    rationale.push(`${dispute.evidence.length} evidence item(s) on file`);

    if (dispute.dispute_type === "bad_evidence" && context.report?.evidence_type === "energy_output") {
      const claimed = Number((context.report.fields as { measured_kwh?: number }).measured_kwh ?? 0);
      const independent = await fetchIndependentEnergyReading();
      const deviationPct = independent ? Math.abs((claimed - independent) / independent) * 100 : 0;
      rationale.push(`claimed ${claimed} kWh vs independent ${independent} kWh (${deviationPct.toFixed(1)}% deviation)`);

      if (deviationPct > 40) {
        rationale.push("deviation far exceeds tolerance → falsified evidence");
        return { verdict: "agent_loses", slash_amount: cspr(10), rationale, confidence: 96 };
      }
      if (deviationPct > 15) {
        rationale.push("material deviation → partial fault");
        return { verdict: "partial_fault", slash_amount: cspr(4), rationale, confidence: 70 };
      }
      rationale.push("within tolerance → agent wins");
      return { verdict: "agent_wins", slash_amount: 0n, rationale, confidence: 80 };
    }

    if (dispute.dispute_type === "agent_default") {
      const line = this.ledger.pool.get(dispute.respondent_agent);
      rationale.push(`outstanding ${line?.drawn ?? 0n} motes past due → default confirmed`);
      return { verdict: "agent_loses", slash_amount: line?.max_credit ?? cspr(10), rationale, confidence: 90 };
    }

    rationale.push("insufficient corroboration to rule against the agent");
    return { verdict: "inconclusive", slash_amount: 0n, rationale, confidence: 50 };
  }
}
