import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { MarketRiskManager } from "../lib/services/market_risk.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p4 — mainnet-beta market risk controls: per-agent + per-category +
 * utilization caps gate every draw, and the insurance reserve absorbs default
 * losses with honest shortfall reporting.
 */

function seed(l: Ledger, id: string, service_type: string) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01a", agent_public_key: "01b", service_type });
}

test("p4: per-agent exposure cap blocks an oversized draw", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(10000), "lp1");
  seed(l, "A", "inference.llm");
  const m = new MarketRiskManager(l, { max_agent_exposure_motes: cspr(100) });
  assert.equal(m.checkDraw("A", cspr(50)).allowed, true);
  const over = m.checkDraw("A", cspr(250));
  assert.equal(over.allowed, false);
  assert.match(over.reason!, /per-agent/);
});

test("p4: approved-category allowlist gates the beta", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(10000), "lp1");
  seed(l, "Inf", "inference.llm");
  seed(l, "Rwa", "rwa.weather_risk");
  const m = new MarketRiskManager(l, { approved_categories: ["rwa"] });
  assert.equal(m.checkDraw("Rwa", cspr(10)).allowed, true, "approved category passes");
  const blocked = m.checkDraw("Inf", cspr(10));
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /not approved/);
});

test("p4: pool utilization ceiling blocks draws beyond the limit", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(100), "lp1");
  seed(l, "A", "data.market");
  const m = new MarketRiskManager(l, { max_pool_utilization_bps: 8000, max_agent_exposure_motes: cspr(1000), max_category_exposure_bps: 10000 });
  const over = m.checkDraw("A", cspr(90)); // 90% > 80% ceiling
  assert.equal(over.allowed, false);
  assert.match(over.reason!, /utilization/);
});

test("p4: insurance reserve absorbs a default loss, reports the shortfall", () => {
  const l = new Ledger();
  // fund the insurance reserve via a slash (30% routes to insurance by default)
  l.agents.register_agent({ agent_id: "Bad", owner_public_key: "01a", agent_public_key: "01b", service_type: "rwa.weather_risk" });
  l.agents.stake("Bad", cspr(100));
  l.slashing.apply_slash({ agent_id: "Bad", amount: cspr(100), reason: "fraud" });
  const reserve0 = BigInt(l.slashing.reserveBalances().insurance_reserve);
  assert.ok(reserve0 > 0n, "reserve funded from slash");

  const m = new MarketRiskManager(l);
  // a default loss smaller than the reserve is fully covered
  const small = m.coverDefault("lp", reserve0 / 2n);
  assert.equal(small.uncovered_motes, "0");
  assert.equal(small.covered_motes, (reserve0 / 2n).toString());
  // a loss larger than the remaining reserve is partially covered, shortfall reported
  const remaining = BigInt(l.slashing.reserveBalances().insurance_reserve);
  const big = m.coverDefault("lp", remaining + cspr(50));
  assert.equal(big.covered_motes, remaining.toString());
  assert.equal(big.uncovered_motes, cspr(50).toString());
  assert.equal(big.reserve_after_motes, "0");
});

test("p4: coverage ratio reports reserve vs outstanding credit", () => {
  const l = new Ledger();
  const m = new MarketRiskManager(l);
  assert.equal(m.coverageRatioBps(), 10000, "no outstanding => fully covered");
});
