import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATEGORY_RISK_BPS,
  DEFAULT_CATEGORY_RISK_BPS,
  categoryFamily,
  categoryRiskBps,
  categoryRiskMultiplier,
} from "../lib/core/service_categories.js";
import { ServiceCategoryRegistry } from "../lib/ledger/contracts/service_category_registry.js";
import { EventBus } from "../lib/ledger/events.js";
import { Clock } from "../lib/ledger/clock.js";

/**
 * Roadmap p1 (now shipped) — docs/risk_model.md's exact per-category weight
 * table, pinned so a future edit to the weights can't silently drift from the
 * documented design:
 *
 *   rwa 1.00 · compliance 0.95 · data/api 0.90 · compute/storage 0.85 ·
 *   inference/dispute 0.80 · defi 0.75 · unknown 0.65 (conservative default)
 */
const DOCUMENTED_MULTIPLIERS: Record<string, number> = {
  rwa: 1.0,
  compliance: 0.95,
  data: 0.9,
  api: 0.9,
  compute: 0.85,
  storage: 0.85,
  inference: 0.8,
  dispute: 0.8,
  defi: 0.75,
};

for (const [family, expected] of Object.entries(DOCUMENTED_MULTIPLIERS)) {
  test(`p1: ${family} family carries the documented x${expected.toFixed(2)} risk multiplier`, () => {
    const serviceType = `${family}.sample_service`;
    assert.equal(categoryFamily(serviceType), family);
    assert.equal(categoryRiskBps(serviceType), expected * 10000);
    assert.equal(categoryRiskMultiplier(serviceType), expected);
    assert.equal(CATEGORY_RISK_BPS[family], expected * 10000);
  });
}

test("p1: an unregistered family falls back to the conservative 0.65x default", () => {
  assert.equal(DEFAULT_CATEGORY_RISK_BPS, 6500);
  assert.equal(categoryRiskMultiplier("totally.unregistered"), 0.65);
  // conservative default must be strictly below every seeded family weight
  for (const bps of Object.values(CATEGORY_RISK_BPS)) {
    assert.ok(DEFAULT_CATEGORY_RISK_BPS < bps, "default is the most conservative weight");
  }
});

test("p1: ServiceCategoryRegistry mirrors the canonical weights for every seeded family", () => {
  const reg = new ServiceCategoryRegistry(new EventBus(), new Clock());
  for (const [family, expected] of Object.entries(DOCUMENTED_MULTIPLIERS)) {
    const seeded = reg.list().find((c) => c.family === family);
    assert.ok(seeded, `registry seeds at least one ${family} category`);
    assert.equal(seeded!.risk_bps, expected * 10000);
    assert.equal(reg.risk_bps(seeded!.category), expected * 10000);
  }
});

test("p1: governance can tune a single category without affecting its siblings", () => {
  const reg = new ServiceCategoryRegistry(new EventBus(), new Clock());
  const before = reg.risk_bps("defi.liquidity_monitoring");
  reg.set_risk_weight("defi.liquidity_monitoring", 7000);
  assert.equal(reg.risk_bps("defi.liquidity_monitoring"), 7000);
  assert.notEqual(reg.risk_bps("defi.liquidity_monitoring"), before);
  // a sibling in the same family (yield_routing) keeps the untouched canonical weight
  assert.equal(reg.risk_bps("defi.yield_routing"), 7500);
});

test("p1: governance can register a brand-new category with its own weight", () => {
  const reg = new ServiceCategoryRegistry(new EventBus(), new Clock());
  assert.equal(reg.is_registered("oracle.price_feed"), false);
  reg.register_category("oracle.price_feed", 8700);
  assert.equal(reg.is_registered("oracle.price_feed"), true);
  assert.equal(reg.risk_bps("oracle.price_feed"), 8700);
});
