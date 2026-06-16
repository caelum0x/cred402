import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { cspr } from "../lib/core/units.js";
import { buildRiskAlerts } from "../lib/services/risk_alerts.js";

test("alerts: a clean, idle pool produces no alerts", () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const report = buildRiskAlerts(ledger);
  assert.equal(report.alerts.length, 0);
  assert.equal(report.counts.critical, 0);
});

test("alerts: an overdue drawn line raises a critical overdue alert", () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  ledger.pool.deposit_liquidity(cspr(1000), "lp");
  const agentId = ledger.agents.list()[0]!.agent_id;
  ledger.pool.open_credit_line({ agent_id: agentId, max_credit: cspr(100), interest_rate_bps: 800, origination_fee_bps: 50, term_seconds: 86_400 });
  ledger.pool.draw(agentId, cspr(40));
  ledger.clock.advance(86_400 * 3); // 3 days past the 1-day term

  const report = buildRiskAlerts(ledger);
  const overdue = report.alerts.find((a) => a.code === "line_overdue");
  assert.ok(overdue, "expected an overdue alert");
  assert.equal(overdue!.severity, "critical");
  assert.equal(overdue!.subject, agentId);
  assert.ok(report.counts.critical >= 1);
});

test("alerts: a single-borrower book triggers a concentration warning", () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  ledger.pool.deposit_liquidity(cspr(1000), "lp");
  const agentId = ledger.agents.list()[0]!.agent_id;
  ledger.pool.open_credit_line({ agent_id: agentId, max_credit: cspr(100), interest_rate_bps: 800, origination_fee_bps: 50, term_seconds: 86_400 });
  ledger.pool.draw(agentId, cspr(40));

  const report = buildRiskAlerts(ledger);
  const conc = report.alerts.find((a) => a.code === "concentration_high");
  assert.ok(conc, "expected a concentration alert (HHI 10000)");
  assert.equal(conc!.severity, "warning");
});

test("alerts: are sorted with critical first", () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  ledger.pool.deposit_liquidity(cspr(1000), "lp");
  const agentId = ledger.agents.list()[0]!.agent_id;
  ledger.pool.open_credit_line({ agent_id: agentId, max_credit: cspr(100), interest_rate_bps: 800, origination_fee_bps: 50, term_seconds: 86_400 });
  ledger.pool.draw(agentId, cspr(40));
  ledger.clock.advance(86_400 * 2);

  const report = buildRiskAlerts(ledger);
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  for (let i = 1; i < report.alerts.length; i++) {
    assert.ok(rank[report.alerts[i]!.severity] >= rank[report.alerts[i - 1]!.severity]);
  }
});
