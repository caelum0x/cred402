import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { findSimilarAgents } from "../lib/services/similar_agents.js";

function reg(l: Ledger, id: string, svc: "monitoring" | "weather_risk", rep: number) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: svc });
  l.agents.seed_profile(id, { reputation_score: rep });
}

test("similar: returns same-category peers, excluding the agent itself", () => {
  const l = new Ledger();
  reg(l, "Target", "weather_risk", 70);
  reg(l, "Near", "weather_risk", 72); // close in standing
  reg(l, "Far", "weather_risk", 20); // far in standing
  reg(l, "OtherCat", "monitoring", 70); // different category — excluded
  const att = new AttestationGraph(l);

  const r = findSimilarAgents(l, att, "Target");
  assert.ok(!("error" in r));
  if ("error" in r) return;
  const ids = r.alternatives.map((a) => a.agent_id);
  assert.ok(!ids.includes("Target"));
  assert.ok(!ids.includes("OtherCat"));
  assert.ok(ids.includes("Near"));
  // the closer peer ranks first (higher similarity)
  assert.equal(r.alternatives[0]!.agent_id, "Near");
  assert.ok(r.alternatives[0]!.similarity > r.alternatives[r.alternatives.length - 1]!.similarity);
});

test("similar: respects the limit", () => {
  const l = new Ledger();
  reg(l, "T", "weather_risk", 60);
  for (let i = 0; i < 6; i++) reg(l, `P${i}`, "weather_risk", 50 + i);
  const r = findSimilarAgents(l, new AttestationGraph(l), "T", 2);
  if ("error" in r) return assert.fail("expected result");
  assert.ok(r.alternatives.length <= 2);
});

test("similar: unknown agent → error", () => {
  const l = new Ledger();
  assert.ok("error" in findSimilarAgents(l, new AttestationGraph(l), "Ghost"));
});
