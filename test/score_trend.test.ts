import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { buildScoreTrend } from "../lib/services/score_trend.js";

function agent(l: Ledger, id: string) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
}

test("trend: reconstructs the reputation trajectory from the event log", () => {
  const l = new Ledger();
  agent(l, "A");
  l.agents.update_reputation("A", 5, "0x1"); // 70 → 75
  l.agents.update_reputation("A", 10, "0x2"); // 75 → 85
  l.agents.update_reputation("A", -20, "0x3"); // 85 → 65

  const trend = buildScoreTrend(l, "A");
  assert.ok(!("error" in trend));
  if ("error" in trend) return;
  const values = trend.reputation.points.map((p) => p.value);
  assert.deepEqual(values, [75, 85, 65]);
  assert.equal(trend.reputation.current, 65);
  assert.equal(trend.reputation.change, 65 - 75); // first → last
});

test("trend: tracks credit-score changes", () => {
  const l = new Ledger();
  agent(l, "B");
  l.agents.set_credit_score("B", 60);
  l.agents.set_credit_score("B", 72);

  const trend = buildScoreTrend(l, "B");
  if ("error" in trend) return assert.fail("expected trend");
  assert.deepEqual(trend.credit_score.points.map((p) => p.value), [60, 72]);
  assert.equal(trend.credit_score.current, 72);
  assert.equal(trend.credit_score.change, 12);
});

test("trend: monotonic sequence and unknown-agent error", () => {
  const l = new Ledger();
  agent(l, "C");
  l.agents.update_reputation("C", 1, "0x1");
  l.agents.update_reputation("C", 1, "0x2");
  const trend = buildScoreTrend(l, "C");
  if ("error" in trend) return assert.fail("expected trend");
  for (let i = 1; i < trend.reputation.points.length; i++) {
    assert.ok(trend.reputation.points[i]!.seq > trend.reputation.points[i - 1]!.seq);
  }
  assert.ok("error" in buildScoreTrend(l, "Nope"));
});
