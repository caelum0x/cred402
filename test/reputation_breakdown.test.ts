import { test } from "node:test";
import assert from "node:assert/strict";

import { Cred402Economy } from "../agents/economy.js";
import { Ledger } from "../lib/ledger/index.js";
import { buildReputationBreakdown } from "../lib/services/reputation_breakdown.js";

test("reputation breakdown: dimensions, weights and contributions reconcile", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  const id = econ.seller.agent_id;

  const b = buildReputationBreakdown(econ.ledger, id);
  assert.ok(!("error" in b));
  if ("error" in b) return;

  // the weighted dimensions (excluding the penalty) define the composite
  const weighted = b.dimensions.filter((d) => d.dimension !== "collusion_penalty");
  const penalty = b.dimensions.find((d) => d.dimension === "collusion_penalty")!;
  const sum = weighted.reduce((s, d) => s + d.contribution, 0) + penalty.contribution;
  assert.ok(Math.abs(sum - b.composite_score) <= 1, `weighted sum ${sum} ≈ composite ${b.composite_score}`);

  // weights of the scored dimensions sum to 1.0
  const weightSum = weighted.reduce((s, d) => s + d.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9);
  // sorted by contribution descending
  for (let i = 1; i < b.dimensions.length; i++) {
    assert.ok(b.dimensions[i - 1]!.contribution >= b.dimensions[i]!.contribution);
  }
});

test("reputation breakdown: an open dispute applies a negative penalty term", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "A", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.disputes.open({ dispute_type: "bad_evidence", complainant: "W", respondent_agent: "A", note: "x", evidence_hash: "0x1" });
  const b = buildReputationBreakdown(l, "A");
  if ("error" in b) return assert.fail("expected breakdown");
  const penalty = b.dimensions.find((d) => d.dimension === "collusion_penalty")!;
  assert.ok(penalty.contribution < 0);
});

test("reputation breakdown: unknown agent → error", () => {
  const l = new Ledger();
  assert.ok("error" in buildReputationBreakdown(l, "Ghost"));
});
