import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { cspr } from "../lib/core/units.js";
import { computeSafeDraw } from "../lib/services/safe_draw.js";

function lineFor(maxCspr: number, drawnCspr: number) {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "A", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.pool.deposit_liquidity(cspr(10_000), "lp");
  l.pool.open_credit_line({ agent_id: "A", max_credit: cspr(maxCspr), interest_rate_bps: 800, origination_fee_bps: 0, term_seconds: 86_400 });
  if (drawnCspr > 0) l.pool.draw("A", cspr(drawnCspr));
  return l;
}

test("safe draw: a 1.5x target caps drawn at max/1.5", () => {
  const l = lineFor(150, 0); // max 150, nothing drawn
  const r = computeSafeDraw(l, "A", 15_000);
  assert.ok(!("error" in r));
  if ("error" in r) return;
  // max drawn for HF≥1.5 = 150/1.5 = 100 CSPR; nothing drawn yet → safe = 100
  assert.equal(Number(r.safe_additional_draw_motes) / 1e9, 100);
  assert.equal(r.resulting_health_factor_bps, 15_000);
  assert.equal(r.limited_by, "target_health");
});

test("safe draw: accounts for existing drawn balance", () => {
  const l = lineFor(150, 60); // already drew 60
  const r = computeSafeDraw(l, "A", 15_000);
  if ("error" in r) return assert.fail("expected advice");
  // max drawn 100, already 60 → safe additional 40
  assert.equal(Number(r.safe_additional_draw_motes) / 1e9, 40);
});

test("safe draw: at/over the target draws nothing more", () => {
  const l = lineFor(150, 100); // exactly at HF 1.5
  const r = computeSafeDraw(l, "A", 15_000);
  if ("error" in r) return assert.fail("expected advice");
  assert.equal(r.safe_additional_draw_motes, "0");
});

test("safe draw: no line → error", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "B", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  assert.ok("error" in computeSafeDraw(l, "B"));
});
