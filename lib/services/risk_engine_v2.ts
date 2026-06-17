import type { Ledger } from "../ledger/ledger.js";
import type { Agent } from "../core/types.js";
import { categoryRiskBps } from "../core/service_categories.js";

/**
 * ML risk-engine v2 (roadmap p7).
 *
 * The v1 risk policy is a hand-tuned rules engine. v2 adds a learned
 * probability-of-default (PD) model: a logistic-regression classifier over agent
 * features that can be TRAINED from realized credit outcomes (who actually
 * defaulted vs repaid), then calibrated against the rules score so the protocol
 * blends judgement with evidence. The model is a real, deterministic logistic
 * regression fit by batch gradient descent — no external ML dependency, fully
 * reproducible, and auditable (weights are inspectable).
 *
 * Higher PD = more likely to default. ml_score = 100·(1 − PD) so it reads on the
 * same 0..100 scale as the rules credit score and can be blended directly.
 */

/** Normalized feature vector in [0,1] (except as noted). Order is stable. */
export interface FeatureVector {
  reputation: number; // reputation_score / 100
  accuracy: number; // accuracy_score / 100
  dispute_rate: number; // already 0..1
  experience: number; // min(1, jobs / EXPERIENCE_SATURATION)
  revenue: number; // min(1, 30d revenue / REVENUE_SATURATION_MOTES)
  stake: number; // min(1, stake / STAKE_SATURATION_MOTES)
  category_risk: number; // 1 − categoryRiskBps/10000 (lower weight = riskier category)
}

export const FEATURE_KEYS: readonly (keyof FeatureVector)[] = [
  "reputation",
  "accuracy",
  "dispute_rate",
  "experience",
  "revenue",
  "stake",
  "category_risk",
];

export interface ModelWeights {
  bias: number;
  weights: Record<keyof FeatureVector, number>;
}

export interface TrainingSample {
  features: FeatureVector;
  /** Realized label: 1 = defaulted, 0 = repaid in good standing. */
  defaulted: 0 | 1;
}

export interface RiskScore {
  agent_id: string;
  pd: number; // 0..1 probability of default
  ml_score: number; // 0..100, = 100·(1 − pd)
  rules_score: number; // 0..100 from the v1 risk policy
  blended_score: number; // 0..100, convex blend of ml + rules
  risk_band: "low" | "moderate" | "elevated" | "high";
  features: FeatureVector;
}

const EXPERIENCE_SATURATION = 50; // jobs at which experience feature saturates
const REVENUE_SATURATION_MOTES = 1000n * 1_000_000_000n; // 1000 CSPR / 30d
const STAKE_SATURATION_MOTES = 500n * 1_000_000_000n; // 500 CSPR
const THIRTY_DAYS = 30 * 86400;

/**
 * Default hand-calibrated weights — a sensible PD prior so the engine is useful
 * before any training. Signs encode domain knowledge: reputation/accuracy/
 * experience/revenue/stake REDUCE default odds; dispute_rate and a riskier
 * category RAISE them. train() can overwrite these from data.
 */
export const PRIOR_WEIGHTS: ModelWeights = {
  bias: 0.5,
  weights: {
    reputation: -3.2,
    accuracy: -1.8,
    dispute_rate: 4.5,
    experience: -1.2,
    revenue: -1.5,
    stake: -1.0,
    category_risk: 1.4,
  },
};

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export class RiskEngineV2 {
  private model: ModelWeights;

  constructor(
    private readonly ledger: Ledger,
    model: ModelWeights = PRIOR_WEIGHTS,
    /** Blend factor: weight on the ML score vs the rules score (0..1). */
    private readonly mlBlend = 0.5,
  ) {
    this.model = cloneModel(model);
  }

  /** Extract the normalized feature vector for an agent. */
  extractFeatures(agent: Agent, now = this.ledger.clock.now()): FeatureVector {
    const recentRevenue = agent.x402_revenue_history
      .filter((e) => e.timestamp >= now - THIRTY_DAYS)
      .reduce((s, e) => s + e.amount, 0n);
    return {
      reputation: clamp01(agent.reputation_score / 100),
      accuracy: clamp01(agent.accuracy_score / 100),
      dispute_rate: clamp01(agent.dispute_rate),
      experience: clamp01(agent.total_jobs_completed / EXPERIENCE_SATURATION),
      revenue: clamp01(Number((recentRevenue * 10000n) / REVENUE_SATURATION_MOTES) / 10000),
      stake: clamp01(Number((agent.stake * 10000n) / STAKE_SATURATION_MOTES) / 10000),
      category_risk: clamp01(1 - categoryRiskBps(agent.service_type) / 10000),
    };
  }

  /** Probability of default for a feature vector under the current model. */
  predictPd(features: FeatureVector): number {
    let z = this.model.bias;
    for (const k of FEATURE_KEYS) z += this.model.weights[k] * features[k];
    return sigmoid(z);
  }

  /**
   * Fit the model from realized outcomes by batch gradient descent on log-loss.
   * Deterministic (no random init): starts from the current weights and returns
   * the trained weights. Pure with respect to the ledger.
   */
  train(samples: TrainingSample[], opts: { epochs?: number; learningRate?: number; l2?: number } = {}): ModelWeights {
    const epochs = opts.epochs ?? 400;
    const lr = opts.learningRate ?? 0.3;
    const l2 = opts.l2 ?? 0.001;
    if (samples.length === 0) return cloneModel(this.model);

    const model = cloneModel(this.model);
    for (let epoch = 0; epoch < epochs; epoch++) {
      let gradBias = 0;
      const grad: Record<keyof FeatureVector, number> = zeroGrad();
      for (const s of samples) {
        let z = model.bias;
        for (const k of FEATURE_KEYS) z += model.weights[k] * s.features[k];
        const err = sigmoid(z) - s.defaulted; // dLoss/dz for log-loss
        gradBias += err;
        for (const k of FEATURE_KEYS) grad[k] += err * s.features[k];
      }
      const n = samples.length;
      model.bias -= lr * (gradBias / n);
      for (const k of FEATURE_KEYS) {
        model.weights[k] -= lr * (grad[k] / n + l2 * model.weights[k]);
      }
    }
    this.model = model;
    return cloneModel(model);
  }

  /** Full risk score for an agent: PD, ML score, rules score, and the blend. */
  score(agentId: string): RiskScore | { error: string } {
    const agent = this.ledger.agents.get(agentId);
    if (!agent) return { error: `unknown agent: ${agentId}` };
    const features = this.extractFeatures(agent);
    const pd = this.predictPd(features);
    const ml_score = Math.round(100 * (1 - pd));
    const rules_score = this.ledger.policy.evaluate(agent).credit_score;
    const blended = Math.round(this.mlBlend * ml_score + (1 - this.mlBlend) * rules_score);
    return {
      agent_id: agentId,
      pd: round4(pd),
      ml_score,
      rules_score,
      blended_score: blended,
      risk_band: pd < 0.1 ? "low" : pd < 0.25 ? "moderate" : pd < 0.5 ? "elevated" : "high",
      features,
    };
  }

  /** The current (trained or prior) model weights — auditable. */
  weights(): ModelWeights {
    return cloneModel(this.model);
  }
}

function cloneModel(m: ModelWeights): ModelWeights {
  return { bias: m.bias, weights: { ...m.weights } };
}

function zeroGrad(): Record<keyof FeatureVector, number> {
  return { reputation: 0, accuracy: 0, dispute_rate: 0, experience: 0, revenue: 0, stake: 0, category_risk: 0 };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
