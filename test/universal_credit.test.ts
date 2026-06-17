import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { Cred402Economy } from "../agents/index.js";
import { policyV1 } from "../lib/core/risk_policy.js";
import {
  categoryRiskMultiplier,
  categoryFamily,
  categoryRiskBps,
} from "../lib/core/service_categories.js";
import { cspr } from "../lib/core/units.js";
import type { Agent } from "../lib/core/types.js";

/**
 * Roadmap p1 — Cred402 is the credit layer for the WHOLE x402 economy, not just
 * RWA. A non-RWA agent (e.g. an inference API) must build a credit line from its
 * x402 receipt history alone, weighted by its service category — no RWA evidence.
 */

function agentWith(service_type: string): Agent {
  const now = Math.floor(Date.now() / 1000);
  return {
    agent_id: "x",
    owner_public_key: "01aa",
    agent_public_key: "01bb",
    service_type,
    stake: cspr(50),
    total_jobs_completed: 400,
    x402_revenue_history: Array.from({ length: 30 }, (_, i) => ({
      receipt_id: `r${i}`,
      amount: cspr(4),
      timestamp: now - i * 24 * 60 * 60,
      service_type,
    })),
    accuracy_score: 92,
    dispute_rate: 0.01,
    reputation_score: 88,
    credit_score: 0,
    current_credit_line: 0n,
    active: true,
    registered_at: now,
  } as Agent;
}

test("p1: ServiceCategoryRegistry seeds non-RWA families with risk weights", () => {
  const l = new Ledger();
  const reg = l.serviceCategories;
  assert.ok(reg.is_registered("inference.llm"), "inference.llm seeded");
  assert.ok(reg.is_registered("data.market"), "data.market seeded");
  assert.ok(reg.list().some((c) => c.family === "compute"), "compute family present");
  assert.equal(reg.risk_bps("rwa.weather_risk"), 10000, "rwa weighted highest");
  assert.ok(reg.risk_bps("inference.llm") < 10000, "inference weighted below rwa");
  // governance can tune a weight + add a brand-new category
  reg.set_risk_weight("inference.llm", 9000);
  assert.equal(reg.risk_bps("inference.llm"), 9000);
  reg.register_category("oracle.price_feed", 8800);
  assert.equal(reg.risk_bps("oracle.price_feed"), 8800);
});

test("p1: a non-RWA agent (inference.llm) gets a credit line from x402 receipts alone", () => {
  const decision = policyV1(agentWith("inference.llm"), Math.floor(Date.now() / 1000));
  assert.ok(decision.credit_line > 0n, "non-RWA agent qualifies for credit");
  assert.ok(decision.credit_score > 0, "has a credit score");
  assert.ok(
    decision.rationale.some((r) => r.includes("inference.llm") && r.includes("risk weight")),
    "rationale records the category risk weight",
  );
});

test("p1: category risk weight scales the credit line (rwa >= inference > defi)", () => {
  const now = Math.floor(Date.now() / 1000);
  const rwa = policyV1(agentWith("rwa.weather_risk"), now).credit_line;
  const inf = policyV1(agentWith("inference.llm"), now).credit_line;
  const defi = policyV1(agentWith("defi.yield_routing"), now).credit_line;
  assert.ok(rwa >= inf, "rwa (1.0x) >= inference (0.8x)");
  assert.ok(inf > defi, "inference (0.8x) > defi (0.75x)");
  // multipliers are the source of the ordering
  assert.ok(categoryRiskMultiplier("rwa.x") > categoryRiskMultiplier("defi.x"));
});

test("p1: unknown family falls back to the conservative default weight", () => {
  assert.equal(categoryFamily("brandnew.thing"), "brandnew");
  assert.equal(categoryRiskBps("brandnew.thing"), 6500);
  assert.ok(categoryRiskMultiplier("brandnew.thing") < categoryRiskMultiplier("data.market"));
});

test("p1: a non-RWA agent underwrites end-to-end through the economy (no RWA evidence)", () => {
  const econ = new Cred402Economy(new Ledger());
  econ.ledger.agents.register_agent({
    agent_id: "InferenceAgent",
    owner_public_key: "01aa",
    agent_public_key: "01bb",
    service_type: "inference.llm",
  });
  econ.ledger.agents.stake("InferenceAgent", cspr(60));
  const now = econ.ledger.clock.now();
  // pure x402 revenue from a non-RWA service — no evidence submitted
  for (let i = 0; i < 20; i++) {
    econ.ledger.agents.record_job(
      "InferenceAgent",
      { receipt_id: `inf-${i}`, amount: cspr(3), timestamp: now - i * 86400, service_type: "inference.llm" },
      95,
      false,
    );
  }
  econ.ledger.agents.update_reputation("InferenceAgent", 85, "0x", "FINALIZED_X402_REVENUE");
  const r = econ.credit.underwrite("InferenceAgent");
  assert.equal(econ.ledger.evidence.list().filter((e) => e.agent_id === "InferenceAgent").length, 0, "no RWA evidence");
  assert.ok(r.line.max_credit > 0n, "non-RWA agent gets a real credit line end-to-end");
});
