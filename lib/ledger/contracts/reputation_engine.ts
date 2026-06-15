import type { Agent } from "../../core/types.js";
import type { ReputationDimensions } from "../../core/protocol_types.js";

/**
 * ReputationEngine (p2 §6.6) — derives a multi-dimensional reputation from an
 * agent's on-chain history and folds it into a single weighted score. Pure
 * integer-friendly math (0..100 per dimension).
 *
 *   reputation = weighted_sum(quality, timeliness, dispute, revenue,
 *                             repayment, expertise) - collusion_penalty
 */
export class ReputationEngine {
  compute(agent: Agent, ctx: { open_disputes: number; repayments_on_time: number; repayments_total: number }): {
    dimensions: ReputationDimensions;
    score: number;
  } {
    const quality_score = clamp(agent.accuracy_score);
    const dispute_score = clamp(100 - agent.dispute_rate * 100 * 5);
    const timeliness_score = clamp(85 + Math.min(15, agent.total_jobs_completed / 50));
    const revenue_score = clamp(Math.min(100, agent.x402_revenue_history.length / 5));
    const repayment_score =
      ctx.repayments_total > 0 ? clamp((ctx.repayments_on_time / ctx.repayments_total) * 100) : 75;
    const category_expertise_score = clamp(60 + Math.min(40, agent.total_jobs_completed / 12));
    const collusion_penalty = ctx.open_disputes * 15;

    const dimensions: ReputationDimensions = {
      quality_score,
      timeliness_score,
      dispute_score,
      revenue_score,
      repayment_score,
      category_expertise_score,
      collusion_penalty,
    };

    // Weights sum to 1.0.
    const weighted =
      0.3 * quality_score +
      0.1 * timeliness_score +
      0.2 * dispute_score +
      0.15 * revenue_score +
      0.15 * repayment_score +
      0.1 * category_expertise_score;

    const score = clamp(Math.round(weighted - collusion_penalty));
    return { dimensions, score };
  }
}

function clamp(x: number): number {
  return Math.max(0, Math.min(100, Math.round(x)));
}
