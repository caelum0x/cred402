import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { RiskEngineV2, type FeatureVector, type TrainingSample } from "../lib/services/risk_engine_v2.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p7 — ML risk-engine v2. A logistic-regression PD model over agent
 * features, trainable from realized outcomes and blended with the v1 rules score.
 */

function seedAgent(l: Ledger, id: string, opts: { service_type: string; rep: number; accuracy: number; jobs: number; stake: bigint; revenue: bigint; disputeRate?: number }) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01a", agent_public_key: "01b", service_type: opts.service_type });
  l.agents.stake(id, opts.stake);
  if (opts.rep !== 70) l.agents.update_reputation(id, opts.rep - 70, "0x", "seed");
  const now = l.clock.now();
  const per = opts.jobs > 0 ? opts.revenue / BigInt(opts.jobs) : 0n;
  for (let i = 0; i < opts.jobs; i++) {
    l.agents.record_job(id, { receipt_id: `${id}-${i}`, amount: per, timestamp: now - i * 3600, service_type: opts.service_type }, opts.accuracy, false);
  }
  if (opts.disputeRate !== undefined) {
    l.agents.seed_profile(id, { dispute_rate: opts.disputeRate });
  }
}

function feat(p: Partial<FeatureVector>): FeatureVector {
  return { reputation: 0.5, accuracy: 0.5, dispute_rate: 0, experience: 0.5, revenue: 0.5, stake: 0.5, category_risk: 0.3, ...p };
}

test("p7: prior model ranks a strong agent below a weak one on PD", () => {
  const l = new Ledger();
  seedAgent(l, "Strong", { service_type: "rwa.weather_risk", rep: 95, accuracy: 98, jobs: 40, stake: cspr(300), revenue: cspr(800) });
  seedAgent(l, "Weak", { service_type: "data.market", rep: 45, accuracy: 50, jobs: 2, stake: cspr(5), revenue: cspr(10), disputeRate: 0.4 });
  const eng = new RiskEngineV2(l);
  const strong = eng.score("Strong");
  const weak = eng.score("Weak");
  assert.ok("pd" in strong && "pd" in weak);
  assert.ok(strong.pd < weak.pd, `strong PD ${strong.pd} should be < weak PD ${weak.pd}`);
  assert.ok(strong.ml_score > weak.ml_score);
  assert.equal(strong.risk_band, "low");
});

test("p7: training reduces log-loss and learns the dispute_rate signal", () => {
  const l = new Ledger();
  const eng = new RiskEngineV2(l);
  // synthetic: default iff dispute_rate high, regardless of other noise
  const samples: TrainingSample[] = [];
  for (let i = 0; i < 40; i++) {
    const high = i % 2 === 0;
    samples.push({ features: feat({ dispute_rate: high ? 0.6 : 0.02, reputation: high ? 0.4 : 0.9 }), defaulted: high ? 1 : 0 });
  }
  const logloss = (eng2: RiskEngineV2) =>
    samples.reduce((s, x) => {
      const p = Math.min(1 - 1e-9, Math.max(1e-9, eng2.predictPd(x.features)));
      return s - (x.defaulted * Math.log(p) + (1 - x.defaulted) * Math.log(1 - p));
    }, 0) / samples.length;

  const before = logloss(eng);
  eng.train(samples, { epochs: 500, learningRate: 0.5 });
  const after = logloss(eng);
  assert.ok(after < before, `loss should drop: ${before} -> ${after}`);
  // model should now separate the two classes
  const pdHigh = eng.predictPd(feat({ dispute_rate: 0.6, reputation: 0.4 }));
  const pdLow = eng.predictPd(feat({ dispute_rate: 0.02, reputation: 0.9 }));
  assert.ok(pdHigh > 0.6 && pdLow < 0.4, `separated: high ${pdHigh}, low ${pdLow}`);
});

test("p7: blended score combines ML and rules scores", () => {
  const l = new Ledger();
  seedAgent(l, "A", { service_type: "rwa.weather_risk", rep: 90, accuracy: 95, jobs: 30, stake: cspr(200), revenue: cspr(500) });
  const eng = new RiskEngineV2(l, undefined, 0.5);
  const s = eng.score("A");
  assert.ok("blended_score" in s);
  const expected = Math.round(0.5 * s.ml_score + 0.5 * s.rules_score);
  assert.equal(s.blended_score, expected);
  assert.ok(s.blended_score >= 0 && s.blended_score <= 100);
});

test("p7: features are normalized to [0,1] and unknown agent errors cleanly", () => {
  const l = new Ledger();
  seedAgent(l, "A", { service_type: "data.market", rep: 80, accuracy: 90, jobs: 100, stake: cspr(9999), revenue: cspr(99999) });
  const eng = new RiskEngineV2(l);
  const s = eng.score("A");
  assert.ok("features" in s);
  for (const v of Object.values(s.features)) assert.ok(v >= 0 && v <= 1, `feature ${v} in [0,1]`);
  assert.deepEqual(eng.score("ghost"), { error: "unknown agent: ghost" });
});

test("p7: weights are auditable and training is deterministic", () => {
  const l = new Ledger();
  const samples: TrainingSample[] = Array.from({ length: 10 }, (_, i) => ({
    features: feat({ dispute_rate: i < 5 ? 0.5 : 0.05 }),
    defaulted: (i < 5 ? 1 : 0) as 0 | 1,
  }));
  const w1 = new RiskEngineV2(l).train(samples, { epochs: 100 });
  const w2 = new RiskEngineV2(l).train(samples, { epochs: 100 });
  assert.deepEqual(w1, w2, "same data + same start => identical weights");
  assert.ok(typeof w1.bias === "number" && typeof w1.weights.dispute_rate === "number");
});
