import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite, PositionEngine, CreditKeeper } from "../lib/flare/index.js";

// The deterministic sim FTSO reference price for XRP/USD (no FLARE_RPC_URL keys).
const SIM_XRP_USD = 0.52;
// FlareSatelliteVault default global exposure cap is $5,000 (USD micro).
const CAP_USD = 5000;
const FXRP = 1_000_000n; // FXRP smallest units per whole token (6 dp)

/**
 * Match flare.test.ts's helper style: build a fresh Ledger + bootstrapped economy
 * and a FlareCreditSatellite, then hang a PositionEngine off the satellite's shared
 * vault + FTSO client (exactly what the CreditKeeper does internally).
 */
function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const satellite = new FlareCreditSatellite(ledger);
  const agentId = econ.seller.agent_id;
  const engine = new PositionEngine(satellite.vault, ledger, satellite.priceClient);
  return { ledger, econ, satellite, agentId, engine, now: ledger.clock.now() };
}

// ---------------------------------------------------------------------------
// PositionEngine
// ---------------------------------------------------------------------------

test("positions: an agent with no debt is 'no_debt', HF Infinity, nothing to deleverage", async () => {
  const { engine, agentId } = setup();
  const pos = await engine.assess(agentId);

  assert.equal(pos.status, "no_debt");
  assert.equal(pos.health_factor, Infinity);
  assert.equal(pos.fxrp_debt, "0");
  assert.equal(pos.deleverage_fxrp, 0);
  assert.equal(pos.debt_usd, 0);
});

test("positions: an $4,420 FXRP debt (8500 FXRP @ $0.52) is a margin call priced off FTSO", async () => {
  const { engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP); // 8500 FXRP = $4,420

  const pos = await engine.assess(agentId);

  assert.equal(pos.xrp_usd, SIM_XRP_USD);
  assert.equal(pos.price_source, "sim");
  assert.equal(pos.debt_usd, 4420); // 8500 × $0.52
  assert.equal(pos.cap_usd, CAP_USD);

  // HF = cap / debt = 5000 / 4420 ≈ 1.131.
  assert.ok(Math.abs(pos.health_factor - CAP_USD / 4420) < 0.01, `HF ${pos.health_factor}`);
  assert.equal(pos.status, "margin_call");

  // Deleverage to restore HF = target 1.5: targetDebt = 5000/1.5 = $3333.33,
  // repay = ($4420 − $3333.33)/$0.52 ≈ 2089.74 FXRP.
  const expectedDeleverage = (4420 - CAP_USD / 1.5) / SIM_XRP_USD;
  assert.ok(pos.deleverage_fxrp > 0);
  assert.ok(
    Math.abs(pos.deleverage_fxrp - expectedDeleverage) < 1,
    `deleverage_fxrp ${pos.deleverage_fxrp} vs ~${expectedDeleverage.toFixed(2)}`,
  );
});

test("positions: priceOverride stress-tests a healthy position into liquidation ('what-if')", async () => {
  const { engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 2000n * FXRP); // 2000 FXRP = $1,040 → HF ≈ 4.8, healthy

  const base = await engine.assess(agentId);
  assert.equal(base.debt_usd, 1040);
  assert.ok(Math.abs(base.health_factor - CAP_USD / 1040) < 0.01);
  assert.equal(base.status, "healthy");

  // A modest override still keeps the position healthy.
  const modest = await engine.assess(agentId, { priceOverride: 1.0 });
  assert.equal(modest.price_source, "what-if");
  assert.equal(modest.debt_usd, 2000); // 2000 × $1.00
  assert.equal(modest.status, "healthy"); // HF 2.5 ≥ watch 1.3

  // "What if XRP triples to $3.00?" → debt $6,000 > cap $5,000 → underwater.
  const stressed = await engine.assess(agentId, { priceOverride: 3.0 });
  assert.equal(stressed.price_source, "what-if");
  assert.equal(stressed.debt_usd, 6000); // 2000 × $3.00
  assert.ok(Math.abs(stressed.health_factor - CAP_USD / 6000) < 0.01); // ≈ 0.83
  assert.ok(stressed.health_factor < 1.0);
  assert.equal(stressed.status, "liquidation");
});

test("positions: price_drift_usd captures oracle-marked drift since the draw", async () => {
  const { engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 2000n * FXRP); // recorded at $0.52 → $1,040 outstanding

  const drifted = await engine.assess(agentId, { priceOverride: 0.62 });
  assert.equal(drifted.recorded_usd, 1040); // Casper-rooted outstanding, $0.52-based
  assert.equal(drifted.debt_usd, 1240); // 2000 × $0.62
  // drift = debt_usd(0.62) − recorded_usd(0.52) = $200.
  assert.ok(drifted.price_drift_usd > 0);
  assert.equal(drifted.price_drift_usd, 200);
});

// ---------------------------------------------------------------------------
// CreditKeeper
// ---------------------------------------------------------------------------

test("keeper: evaluate() on a no-debt agent recommends no action", async () => {
  const { ledger, satellite, agentId } = setup();
  const keeper = new CreditKeeper(satellite, ledger);

  const decision = await keeper.evaluate(agentId);
  assert.equal(decision.action, "none");
  assert.equal(decision.amount_fxrp, 0);
  assert.equal(decision.position.status, "no_debt");
});

test("keeper: evaluate() on a margin-call agent recommends a deleverage citing the health factor", async () => {
  const { ledger, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP);
  const keeper = new CreditKeeper(satellite, ledger);

  const decision = await keeper.evaluate(agentId);
  assert.equal(decision.action, "deleverage");
  assert.ok(decision.amount_fxrp > 0);
  assert.match(decision.reason, /health factor/i);
  assert.equal(decision.position.status, "margin_call");
});

test("keeper: run() with dryRun never executes and leaves the position untouched", async () => {
  const { ledger, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP);
  const before = satellite.vault.debtOf(agentId);
  assert.equal(before, 8500n * FXRP);

  const keeper = new CreditKeeper(satellite, ledger, { dryRun: true });
  const res = await keeper.run(agentId);

  assert.equal(res.action, "deleverage");
  assert.equal(res.executed, false);
  assert.equal(res.tx_hash, "");
  // The FXRP debt must be completely unchanged — dryRun only reports.
  assert.equal(satellite.vault.debtOf(agentId), before);
});

test("keeper: run() deleverages a margin call through KeeperHub and restores HF to target", async () => {
  const { ledger, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP);
  const debtBefore = satellite.vault.debtOf(agentId);

  const keeper = new CreditKeeper(satellite, ledger);
  const res = await keeper.run(agentId);

  assert.equal(res.executed, true);
  assert.equal(res.ok, true);
  assert.ok(res.tx_hash.length > 0, "expected a non-empty KeeperHub tx hash");
  assert.ok(res.keeperhub_audit_id, "expected a KeeperHub audit id");

  // The vault debt is actually reduced by the deleverage.
  const debtAfter = satellite.vault.debtOf(agentId);
  assert.ok(debtAfter < debtBefore, `debt ${debtAfter} should be < ${debtBefore}`);

  // Re-marking to the same $0.52 oracle, the cured position sits at the target HF.
  const cured = await keeper.evaluate(agentId);
  assert.equal(cured.position.status, "healthy");
  assert.ok(
    Math.abs(cured.position.health_factor - 1.5) < 0.02,
    `HF ${cured.position.health_factor} should be ≈ target 1.5`,
  );
});

test("keeper: runFleet reports across the fleet and executes only the risky position", async () => {
  const { ledger, econ, satellite } = setup();
  // Open one risky position on the seller; the buyer stays debt-free.
  await satellite.draw(econ.seller.agent_id, 8500n * FXRP);

  const agentIds = [econ.buyer.agent_id, econ.seller.agent_id];
  const keeper = new CreditKeeper(satellite, ledger);
  const { summary } = await keeper.runFleet(agentIds);

  assert.equal(summary.evaluated, agentIds.length);
  assert.ok(summary.executed >= 1, "at least the risky seller position should execute");
  assert.ok(summary.total_deleveraged_fxrp > 0);
  assert.ok(summary.by_status && typeof summary.by_status === "object");
  // The debt-free buyer contributes a no_debt status to the rollup.
  assert.ok((summary.by_status["no_debt"] ?? 0) >= 1);
});

test("keeper: deleveraging reconciles the USD-denominated global exposure downward", async () => {
  const { ledger, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP);

  const before = ledger.exposure.get_agent_global_exposure(agentId)!;
  assert.equal(before.outstanding, 4_420_000_000n); // $4,420 USD micro, not FXRP units

  const keeper = new CreditKeeper(satellite, ledger);
  const res = await keeper.run(agentId);
  assert.equal(res.executed, true);

  const after = ledger.exposure.get_agent_global_exposure(agentId)!;
  // Outstanding must decrease and land near the target debt ($3,333 micro), proving
  // the reconciliation happens in the USD denominator (not raw FXRP token units).
  assert.ok(after.outstanding < before.outstanding, `outstanding ${after.outstanding} should drop`);
  assert.ok(after.outstanding > 3_300_000_000n && after.outstanding < 3_400_000_000n, `outstanding ${after.outstanding}`);
});
