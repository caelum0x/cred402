import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { buildPeerBenchmark } from "../lib/services/peer_benchmark.js";

function reg(l: Ledger, id: string, rep: number) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.agents.seed_profile(id, { reputation_score: rep });
}

test("benchmark: ranks an agent within its service-type cohort", () => {
  const l = new Ledger();
  reg(l, "Top", 90);
  reg(l, "Mid", 60);
  reg(l, "Low", 30);

  const top = buildPeerBenchmark(l, "Top");
  assert.ok(!("error" in top));
  if ("error" in top) return;
  assert.equal(top.cohort_size, 3);
  assert.equal(top.service_type, "monitoring");
  assert.equal(top.reputation.rank, 1);
  assert.equal(top.reputation.cohort_median, 60);
  assert.equal(top.reputation.percentile, 100); // best reputation → top percentile

  const low = buildPeerBenchmark(l, "Low");
  if ("error" in low) return;
  assert.equal(low.reputation.rank, 3);
  assert.ok(low.reputation.percentile < top.reputation.percentile);
});

test("benchmark: fraud percentile inverts (lower fraud is better)", () => {
  const l = new Ledger();
  reg(l, "Clean", 80);
  reg(l, "Alsoclean", 80);
  const b = buildPeerBenchmark(l, "Clean");
  if ("error" in b) return;
  // with no suspicious activity both have low fraud → high (favorable) percentile
  assert.ok(b.fraud_score.percentile >= 50);
  assert.ok(b.overall_percentile >= 0 && b.overall_percentile <= 100);
});

test("benchmark: unknown agent returns an error", () => {
  const l = new Ledger();
  const b = buildPeerBenchmark(l, "Nope");
  assert.ok("error" in b);
});
