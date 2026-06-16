import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { cspr } from "../lib/core/units.js";
import { computeCreditCost } from "../lib/services/credit_cost.js";

function lineFor(aprBps: number, origBps: number, termSeconds: number) {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "A", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.pool.deposit_liquidity(cspr(1000), "lp");
  l.pool.open_credit_line({ agent_id: "A", max_credit: cspr(100), interest_rate_bps: aprBps, origination_fee_bps: origBps, term_seconds: termSeconds });
  return { l, econ: new ProtocolEconomics() };
}

test("cost: itemizes origination + prorated interest for a draw", () => {
  const { l, econ } = lineFor(1000, 100, 365 * 24 * 60 * 60); // 10% APR, 1% origination, 1y term
  const c = computeCreditCost(l, econ, "A", 50);
  assert.ok(!("error" in c));
  if ("error" in c) return;
  // full-year interest on 50 @ 10% = 5 CSPR; origination uses the protocol schedule (default 0.5%).
  assert.ok(Math.abs(Number(c.interest_estimate_motes) / 1e9 - 5) < 0.01, `~5 CSPR interest, got ${Number(c.interest_estimate_motes) / 1e9}`);
  assert.equal(c.total_repayment_motes, (cspr(50) + BigInt(c.interest_estimate_motes)).toString());
  assert.ok(Number(c.all_in_cost_motes) > 0);
  assert.equal(c.term_days, 365);
});

test("cost: interest scales down with a shorter term", () => {
  const yearCost = computeCreditCost(...Object.values(lineFor(1000, 50, 365 * 86_400)) as [Ledger, ProtocolEconomics], "A", 50);
  const monthCost = computeCreditCost(...Object.values(lineFor(1000, 50, 30 * 86_400)) as [Ledger, ProtocolEconomics], "A", 50);
  if ("error" in yearCost || "error" in monthCost) return assert.fail("expected costs");
  assert.ok(Number(monthCost.interest_estimate_motes) < Number(yearCost.interest_estimate_motes));
});

test("cost: a draw beyond headroom is rejected", () => {
  const { l, econ } = lineFor(1000, 50, 86_400);
  const c = computeCreditCost(l, econ, "A", 500); // max is 100
  assert.ok("error" in c);
  assert.match((c as { error: string }).error, /headroom/);
});

test("cost: no line → error", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "B", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  assert.ok("error" in computeCreditCost(l, new ProtocolEconomics(), "B", 5));
});
