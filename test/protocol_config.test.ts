import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { buildProtocolConfig } from "../lib/services/protocol_config.js";

test("config: exposes fees, governance gates and the full tier table", () => {
  const l = new Ledger();
  const cfg = buildProtocolConfig(l);

  assert.equal(typeof cfg.policy_version, "string");
  assert.ok(cfg.fees.origination_fee_bps > 0);
  assert.ok(cfg.fees.interest_spread_bps > 0);
  assert.equal(cfg.governance.min_reputation_to_draw, l.governance.get().min_reputation_to_draw);
  assert.equal(cfg.governance.max_agent_exposure_motes, l.governance.get().max_agent_exposure.toString());
  assert.equal(cfg.units.motes_per_cspr, 1_000_000_000);

  // tier table is ordered and monotonic in thresholds + multipliers
  const tiers = cfg.reputation_tiers;
  assert.equal(tiers[0]!.tier, "unrated");
  assert.equal(tiers[tiers.length - 1]!.tier, "diamond");
  for (let i = 1; i < tiers.length; i++) {
    assert.ok(tiers[i]!.min_reputation >= tiers[i - 1]!.min_reputation);
    assert.ok(tiers[i]!.credit_multiplier >= tiers[i - 1]!.credit_multiplier);
  }
});
