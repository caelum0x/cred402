import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { Cred402CreditOracle } from "../lib/services/credit_oracle.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p3 — Credit-as-a-service ("Cred402 Inside"). A third-party x402 platform
 * queries the oracle for an agent's creditworthiness and gets the same answer
 * Cred402 would — including for non-RWA services (p1).
 */

function seedAgent(l: Ledger, id: string, service_type: string, rep: number) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01aa", agent_public_key: "01bb", service_type });
  l.agents.stake(id, cspr(50));
  const now = l.clock.now();
  for (let i = 0; i < 20; i++) {
    l.agents.record_job(id, { receipt_id: `${id}-${i}`, amount: cspr(4), timestamp: now - i * 86400, service_type }, 95, false);
  }
  l.agents.update_reputation(id, rep, "0x", "FINALIZED_X402_REVENUE");
}

test("p3 oracle: creditCheck on an eligible non-RWA agent returns a usable line", () => {
  const l = new Ledger();
  seedAgent(l, "InferenceAgent", "inference.llm", 85);
  const oracle = new Cred402CreditOracle(l);
  const c = oracle.creditCheck("InferenceAgent");
  assert.equal(c.exists, true);
  assert.equal(c.eligible, true, c.ineligible_reason);
  assert.equal(c.service_type, "inference.llm");
  assert.ok(BigInt(c.recommended_limit_motes) > 0n, "recommends a limit");
  assert.ok(c.credit_score > 0 && c.credit_score <= 100);
  assert.ok(c.policy_version.length > 0, "answer is policy-version stamped");
});

test("p3 oracle: unknown agent is a clean, non-throwing negative", () => {
  const c = new Cred402CreditOracle(new Ledger()).creditCheck("nobody");
  assert.equal(c.exists, false);
  assert.equal(c.eligible, false);
  assert.equal(c.recommended_limit_motes, "0");
  assert.deepEqual(c.risk_flags, ["unknown_agent"]);
});

test("p3 oracle: below-min-reputation agent is ineligible with a reason + flag", () => {
  const l = new Ledger();
  seedAgent(l, "WeakAgent", "data.market", -55); // 70 + (-55) = 15, below the min of 40
  const c = new Cred402CreditOracle(l).creditCheck("WeakAgent");
  assert.equal(c.eligible, false);
  assert.match(c.ineligible_reason ?? "", /reputation/i);
  assert.ok(c.risk_flags.includes("below_min_reputation"));
  assert.equal(c.recommended_limit_motes, "0", "no limit offered to ineligible agents");
});

test("p3 oracle: simulate previews a line for hypothetical signals (no agent needed)", () => {
  const oracle = new Cred402CreditOracle(new Ledger());
  const r = oracle.simulate({ monthly_revenue_cspr: 120, stake_cspr: 80, reputation: 90, accuracy: 95, service_type: "compute.gpu" });
  assert.ok(r.estimated_credit_line_cspr > 0);
  assert.equal(r.input.service_type, "compute.gpu");
});

test("p3 oracle: batch check ranks a marketplace's agents", () => {
  const l = new Ledger();
  seedAgent(l, "A", "api.generic", 90);
  seedAgent(l, "B", "inference.llm", 80);
  const checks = new Cred402CreditOracle(l).creditChecks(["A", "B", "ghost"]);
  assert.equal(checks.length, 3);
  assert.equal(checks[2]!.exists, false);
  assert.ok(checks.filter((c) => c.eligible).length >= 2);
});
