import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Marketplace } from "../lib/services/marketplace.js";
import { cspr } from "../lib/core/units.js";
import { buildMarketplaceStats } from "../lib/services/marketplace_stats.js";

function setup() {
  const l = new Ledger();
  const reg = (id: string) => l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  reg("S1");
  reg("S2");
  const m = new Marketplace(l);
  return { l, m };
}

test("marketplace stats: empty book is zeroed", () => {
  const { m } = setup();
  const s = buildMarketplaceStats(m);
  assert.equal(s.total_listings, 0);
  assert.equal(s.sellers, 0);
  assert.equal(s.price_motes.avg, "0");
});

test("marketplace stats: aggregates categories, strategies, prices and sellers", () => {
  const { m } = setup();
  m.list({ agent_id: "S1", category: "rwa.weather_risk", strategy: "fixed", base_price: cspr(2) });
  m.list({ agent_id: "S1", category: "rwa.weather_risk", strategy: "dynamic", base_price: cspr(4) });
  m.list({ agent_id: "S2", category: "rwa.invoice_validity", strategy: "fixed", base_price: cspr(6) });

  const s = buildMarketplaceStats(m);
  assert.equal(s.total_listings, 3);
  assert.equal(s.sellers, 2);
  assert.equal(s.by_category["rwa.weather_risk"], 2);
  assert.equal(s.by_strategy["fixed"], 2);
  assert.equal(s.price_motes.min, cspr(2).toString());
  assert.equal(s.price_motes.max, cspr(6).toString());
  assert.equal(s.price_motes.avg, cspr(4).toString()); // (2+4+6)/3
  // S1 has the most listings
  assert.equal(s.top_sellers[0]!.agent_id, "S1");
  assert.equal(s.top_sellers[0]!.listings, 2);
});
