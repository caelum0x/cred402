import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { simulateUnderwriting } from "../lib/services/credit_simulator.js";

test("simulator: more revenue → a larger credit line, monotonically", () => {
  const ledger = new Ledger();
  const low = simulateUnderwriting(ledger, { monthly_revenue_cspr: 1000, reputation: 80 });
  const high = simulateUnderwriting(ledger, { monthly_revenue_cspr: 8000, reputation: 80 });
  assert.ok(high.estimated_credit_line_cspr >= low.estimated_credit_line_cspr);
  assert.ok(low.decision.credit_line >= 0n);
});

test("simulator: reputation below the governance floor is ineligible", () => {
  const ledger = new Ledger();
  const gov = ledger.governance.get();
  const r = simulateUnderwriting(ledger, { monthly_revenue_cspr: 500, reputation: gov.min_reputation_to_draw - 5 });
  assert.equal(r.eligible, false);
  assert.match(r.ineligible_reason ?? "", /below minimum/);
});

test("simulator: the governance exposure cap bounds the estimate", () => {
  const ledger = new Ledger();
  const gov = ledger.governance.get();
  const huge = simulateUnderwriting(ledger, { monthly_revenue_cspr: 10_000_000, stake_cspr: 1_000_000, reputation: 99, accuracy: 100 });
  assert.equal(huge.decision.credit_line, gov.max_agent_exposure);
  assert.equal(huge.governance_capped, true);
});

test("simulator: is read-only — no agent or credit line is created", () => {
  const ledger = new Ledger();
  const agentsBefore = ledger.agents.list().length;
  const linesBefore = ledger.pool.list().length;
  simulateUnderwriting(ledger, { monthly_revenue_cspr: 5000, reputation: 90 });
  assert.equal(ledger.agents.list().length, agentsBefore);
  assert.equal(ledger.pool.list().length, linesBefore);
  assert.equal(ledger.agents.get("__simulation__"), undefined);
});
