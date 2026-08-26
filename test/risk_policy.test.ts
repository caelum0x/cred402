import { test } from "node:test";
import assert from "node:assert/strict";

import { cspr } from "../lib/core/units.js";
import { last30DayRevenue, policyV1, policyV2, POLICIES } from "../lib/core/risk_policy.js";
import type { Agent, RevenueEvent } from "../lib/core/types.js";

const NOW = 1_700_000_000;

function revenue(count: number, per: string, now = NOW): RevenueEvent[] {
  return Array.from({ length: count }, (_, i) => ({
    receipt_id: `r${i}`,
    amount: cspr(per),
    timestamp: now - i * 3600, // hourly, all inside the 30-day window
    service_type: "solar_output_verification",
  }));
}

function baseAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: "A",
    owner_public_key: "01ab",
    agent_public_key: "01ab",
    service_type: "solar_output_verification",
    stake: cspr(50),
    total_jobs_completed: 200,
    x402_revenue_history: revenue(30, "1.0"),
    accuracy_score: 90,
    dispute_rate: 0.02,
    reputation_score: 88,
    credit_score: 0,
    active: true,
    registered_at: NOW - 86_400,
    ...overrides,
  };
}

test("last30DayRevenue: sums only receipts inside the 30-day window", () => {
  const inWindow = revenue(5, "1.0");
  const stale = revenue(5, "1.0").map((e) => ({ ...e, timestamp: NOW - 40 * 24 * 3600 }));
  const total = last30DayRevenue([...inWindow, ...stale], NOW);
  assert.equal(total, cspr("5.0"));
});

test("last30DayRevenue: never returns a negative total from malformed amounts", () => {
  const poisoned: RevenueEvent[] = [
    { receipt_id: "good", amount: cspr("1.0"), timestamp: NOW, service_type: "x" },
    { receipt_id: "bad", amount: -cspr("100.0"), timestamp: NOW, service_type: "x" },
  ];
  assert.equal(last30DayRevenue(poisoned, NOW), 0n);
});

test("policyV1: healthy agent gets a positive line, sane score and interest", () => {
  const d = policyV1(baseAgent(), NOW);
  assert.ok(d.credit_line > 0n, "credit line should be positive");
  assert.equal(d.policy_version, "v1");
  assert.ok(d.credit_score > 0 && d.credit_score <= 100);
  assert.ok(d.interest_rate_bps >= 800 && d.interest_rate_bps <= 2200);
  assert.ok(d.rationale.length > 0);
});

test("policyV2: rewards throughput over v1 for a high-job agent", () => {
  const a = baseAgent({ total_jobs_completed: 900 });
  assert.ok(policyV2(a, NOW).credit_line > policyV1(a, NOW).credit_line);
});

test("POLICIES registry exposes v1 and v2", () => {
  assert.equal(POLICIES.v1, policyV1);
  assert.equal(POLICIES.v2, policyV2);
});

// --- Input-validation guards (the underwriting brain must never trust raw metrics) ---

test("guard: accuracy_score above 100 does not inflate the line beyond a 100-capped agent", () => {
  const capped = policyV1(baseAgent({ accuracy_score: 100 }), NOW).credit_line;
  const overflowing = policyV1(baseAgent({ accuracy_score: 250 }), NOW).credit_line;
  assert.equal(overflowing, capped, "accuracy_score must be clamped to 100");
});

test("guard: negative accuracy_score cannot produce a negative credit line", () => {
  const d = policyV1(baseAgent({ accuracy_score: -50 }), NOW);
  assert.equal(d.credit_line, 0n, "clamped accuracy 0 => zero line, never negative");
  assert.ok(d.credit_score >= 0);
});

test("guard: negative dispute_rate is clamped, never boosting the line above a clean agent", () => {
  const clean = policyV1(baseAgent({ dispute_rate: 0 }), NOW).credit_line;
  const cheating = policyV1(baseAgent({ dispute_rate: -1 }), NOW).credit_line;
  assert.equal(cheating, clean, "dispute_rate < 0 must clamp to 0");
});

test("guard: dispute_rate above 1 stays at the penalty floor, never negative multiplier", () => {
  const d = policyV1(baseAgent({ dispute_rate: 5 }), NOW);
  assert.ok(d.credit_line >= 0n);
  assert.ok(d.dispute_penalty >= 0.2 - 1e-9, "v1 penalty floor holds");
});

test("guard: negative stake is treated as zero stake", () => {
  const zero = policyV1(baseAgent({ stake: 0n }), NOW).credit_line;
  const negative = policyV1(baseAgent({ stake: -cspr(1000) }), NOW).credit_line;
  assert.equal(negative, zero, "negative stake must clamp to 0");
});

test("guard: NaN metrics degrade to the safe floor rather than propagating NaN", () => {
  const d = policyV1(baseAgent({ accuracy_score: NaN, dispute_rate: NaN }), NOW);
  assert.equal(d.credit_line, 0n);
  assert.ok(Number.isFinite(d.credit_score));
  assert.ok(Number.isFinite(d.interest_rate_bps));
});

test("guard: negative total_jobs_completed does not shrink the v2 throughput bonus below 1", () => {
  const d = policyV2(baseAgent({ total_jobs_completed: -500 }), NOW);
  assert.ok(d.credit_line >= 0n);
  // Throughput bonus is 1 + jobs/1000 with jobs floored at 0, so a negative
  // job count must not drop the multiplier below 1 (which would cut the line).
  const zeroJobs = policyV2(baseAgent({ total_jobs_completed: 0 }), NOW).credit_line;
  assert.equal(d.credit_line, zeroJobs);
});

test("guard: valid in-domain inputs are unchanged (normalization is identity)", () => {
  // Regression: normalization must not alter decisions for already-valid agents.
  const a = baseAgent({ accuracy_score: 90, dispute_rate: 0.02, stake: cspr(50), total_jobs_completed: 200 });
  const d = policyV1(a, NOW);
  const revenue30 = last30DayRevenue(a.x402_revenue_history, NOW);
  assert.equal(d.last_30_day_revenue, revenue30);
  assert.ok(d.credit_line > 0n);
});
