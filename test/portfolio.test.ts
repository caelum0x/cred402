import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { cspr } from "../lib/core/units.js";
import { buildPortfolioReport } from "../lib/services/portfolio.js";

function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  return { ledger, econ };
}

test("portfolio: empty book is diversified with zero HHI", () => {
  const { ledger } = setup();
  const r = buildPortfolioReport(ledger);
  assert.equal(r.hhi, 0);
  assert.equal(r.concentration_band, "diversified");
  assert.equal(r.largest_borrower, null);
  assert.equal(r.by_agent.length, 0);
});

test("portfolio: a single drawn line is 100% concentrated (HHI 10000)", () => {
  const { ledger } = setup();
  ledger.pool.deposit_liquidity(cspr(1000), "lp1");
  const agentId = ledger.agents.list()[0]!.agent_id;
  ledger.pool.open_credit_line({ agent_id: agentId, max_credit: cspr(100), interest_rate_bps: 800, origination_fee_bps: 50, term_seconds: 86_400 });
  ledger.pool.draw(agentId, cspr(40));

  const r = buildPortfolioReport(ledger);
  assert.equal(r.hhi, 10000);
  assert.equal(r.concentration_band, "concentrated");
  assert.equal(r.largest_borrower!.key, agentId);
  assert.equal(r.largest_borrower!.share_bps, 10000);
  assert.equal(r.outstanding_motes, cspr(40).toString());
});

test("portfolio: spreading exposure across borrowers lowers HHI", () => {
  const { ledger } = setup();
  ledger.pool.deposit_liquidity(cspr(5000), "lp1");
  const agents = ledger.agents.list().slice(0, 4);
  assert.ok(agents.length >= 2, "need multiple agents to diversify");
  for (const a of agents) {
    ledger.pool.open_credit_line({ agent_id: a.agent_id, max_credit: cspr(100), interest_rate_bps: 800, origination_fee_bps: 50, term_seconds: 86_400 });
    ledger.pool.draw(a.agent_id, cspr(40)); // equal $40 each → maximally diversified for N names
  }
  const r = buildPortfolioReport(ledger);
  // N equal names → HHI = 10000 / N
  const expected = Math.round(10000 / agents.length);
  assert.ok(Math.abs(r.hhi - expected) <= agents.length, `HHI ${r.hhi} ~ ${expected}`);
  assert.ok(r.hhi < 10000);
  assert.equal(r.by_agent.length, agents.length);
});
