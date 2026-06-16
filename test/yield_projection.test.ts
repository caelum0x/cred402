import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { cspr } from "../lib/core/units.js";
import { buildYieldProjection } from "../lib/services/yield_projection.js";

function bookWithDraw(aprBps: number) {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  ledger.pool.deposit_liquidity(cspr(1000), "lp");
  const agentId = ledger.agents.list()[0]!.agent_id;
  ledger.pool.open_credit_line({ agent_id: agentId, max_credit: cspr(100), interest_rate_bps: aprBps, origination_fee_bps: 0, term_seconds: 86_400 });
  ledger.pool.draw(agentId, cspr(100));
  return { ledger, economics: new ProtocolEconomics() };
}

test("yield: empty book projects zero yield", () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const proj = buildYieldProjection(ledger, new ProtocolEconomics());
  assert.equal(proj.outstanding_motes, "0");
  for (const h of proj.horizons) {
    assert.equal(h.gross_interest_motes, "0");
    assert.equal(h.projected_apy, 0);
  }
});

test("yield: 365-day gross interest ≈ drawn × APR, LP gets interest minus the protocol spread", () => {
  const { ledger, economics } = bookWithDraw(1000); // 10% APR on 100 CSPR drawn
  const proj = buildYieldProjection(ledger, economics);
  const annual = proj.horizons.find((h) => h.horizon_days === 365)!;
  // gross ≈ 100 * 10% = 10 CSPR
  const gross = Number(annual.gross_interest_motes) / 1e9;
  assert.ok(Math.abs(gross - 10) < 0.05, `gross ~10 CSPR, got ${gross}`);
  // LP share = gross − 10% protocol spread = 9 CSPR
  const lp = Number(annual.lp_interest_motes) / 1e9;
  assert.ok(Math.abs(lp - 9) < 0.05, `lp ~9 CSPR, got ${lp}`);
  assert.equal(proj.protocol_spread_bps, 1000);
  assert.equal(proj.weighted_avg_apr_bps, 1000);
});

test("yield: projected APY scales with the weighted-average APR", () => {
  const lowApr = buildYieldProjection(...Object.values(bookWithDraw(500)) as [any, any]);
  const highApr = buildYieldProjection(...Object.values(bookWithDraw(1500)) as [any, any]);
  const lowApy = lowApr.horizons.find((h) => h.horizon_days === 365)!.projected_apy;
  const highApy = highApr.horizons.find((h) => h.horizon_days === 365)!.projected_apy;
  assert.ok(highApy > lowApy, `higher APR → higher projected APY (${highApy} > ${lowApy})`);
});
