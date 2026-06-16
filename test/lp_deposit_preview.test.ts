import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { cspr } from "../lib/core/units.js";
import { buildLpDepositPreview } from "../lib/services/lp_deposit_preview.js";

test("lp preview: share reflects the deposit relative to the resulting pool", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(1000), "existing");
  const p = buildLpDepositPreview(l, new ProtocolEconomics(), 1000);
  assert.ok(!("error" in p));
  if ("error" in p) return;
  // 1000 into a 1000 pool → 2000 total, 50% share
  assert.equal(p.resulting_liquidity_motes, cspr(2000).toString());
  assert.equal(p.resulting_share, 0.5);
});

test("lp preview: a deposit into an empty pool is 100% share", () => {
  const l = new Ledger();
  const p = buildLpDepositPreview(l, new ProtocolEconomics(), 500);
  if ("error" in p) return assert.fail("expected preview");
  assert.equal(p.resulting_share, 1);
});

test("lp preview: projected annual yield = deposit × projected APY", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(1000), "lp");
  const econ = new ProtocolEconomics();
  const p = buildLpDepositPreview(l, econ, 1000);
  if ("error" in p) return assert.fail("expected preview");
  const expected = Math.round(Number(cspr(1000)) * p.projected_apy);
  assert.equal(p.projected_annual_yield_motes, String(expected));
});

test("lp preview: non-positive deposit → error", () => {
  const l = new Ledger();
  assert.ok("error" in buildLpDepositPreview(l, new ProtocolEconomics(), 0));
  assert.ok("error" in buildLpDepositPreview(l, new ProtocolEconomics(), -5));
});
