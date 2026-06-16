import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { buildAgentHealthBadge } from "../lib/services/agent_health.js";

function reg(l: Ledger, id: string, rep: number) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.agents.seed_profile(id, { reputation_score: rep });
}

test("health: a clean high-reputation agent is green", () => {
  const l = new Ledger();
  reg(l, "Healthy", 90);
  const b = buildAgentHealthBadge(l, "Healthy");
  assert.ok(!("error" in b));
  if ("error" in b) return;
  assert.equal(b.status, "green");
  assert.ok(b.score >= 80);
  assert.ok(b.factors.every((f) => f.status === "green"));
});

test("health: an open dispute forces red (worst-of)", () => {
  const l = new Ledger();
  reg(l, "Disputed", 90);
  l.disputes.open({ dispute_type: "bad_evidence", complainant: "W", respondent_agent: "Disputed", note: "x", evidence_hash: "0x1" });
  const b = buildAgentHealthBadge(l, "Disputed");
  if ("error" in b) return assert.fail("expected a badge");
  assert.equal(b.status, "red"); // even with high reputation, an open dispute is red
  const disputes = b.factors.find((f) => f.label === "disputes")!;
  assert.equal(disputes.status, "red");
});

test("health: a mid-reputation agent is amber", () => {
  const l = new Ledger();
  reg(l, "Mid", 55);
  const b = buildAgentHealthBadge(l, "Mid");
  if ("error" in b) return assert.fail("expected a badge");
  assert.equal(b.status, "amber");
});

test("health: unknown agent → error", () => {
  const l = new Ledger();
  assert.ok("error" in buildAgentHealthBadge(l, "Ghost"));
});
