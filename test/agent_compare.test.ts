import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { compareAgents } from "../lib/services/agent_compare.js";

function reg(l: Ledger, id: string, rep: number, credit: number) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.agents.seed_profile(id, { reputation_score: rep });
  l.agents.set_credit_score(id, credit);
}

test("compare: picks the stronger agent and reports per-metric winners", () => {
  const l = new Ledger();
  reg(l, "Strong", 90, 85);
  reg(l, "Weak", 50, 40);
  const att = new AttestationGraph(l);

  const cmp = compareAgents(l, att, "Strong", "Weak");
  assert.ok(!("error" in cmp));
  if ("error" in cmp) return;
  assert.equal(cmp.overall_winner, "a");
  const rep = cmp.metrics.find((m) => m.metric === "reputation")!;
  assert.equal(rep.winner, "a");
  assert.equal(rep.higher_is_better, true);
});

test("compare: lower-is-better metrics invert the winner", () => {
  const l = new Ledger();
  reg(l, "Clean", 80, 70);
  reg(l, "Clean2", 80, 70);
  const att = new AttestationGraph(l);
  const cmp = compareAgents(l, att, "Clean", "Clean2");
  if ("error" in cmp) return assert.fail("expected comparison");
  const fraud = cmp.metrics.find((m) => m.metric === "fraud_score")!;
  assert.equal(fraud.higher_is_better, false);
  const dispute = cmp.metrics.find((m) => m.metric === "dispute_rate")!;
  assert.equal(dispute.higher_is_better, false);
});

test("compare: unknown agent → error", () => {
  const l = new Ledger();
  reg(l, "Real", 70, 50);
  const att = new AttestationGraph(l);
  assert.ok("error" in compareAgents(l, att, "Real", "Ghost"));
  assert.ok("error" in compareAgents(l, att, "Ghost", "Real"));
});
