import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite, PositionEngine, AutomationEngine } from "../lib/flare/index.js";
import { KeeperHubClient } from "../lib/keeperhub/client.js";

// The deterministic sim FTSO reference price for XRP/USD (no FLARE_RPC_URL keys).
const SIM_XRP_USD = 0.52;
// FlareCreditSatellite default global exposure cap is $5,000 (USD micro).
const CAP_USD = 5000;
const FXRP = 1_000_000n; // FXRP smallest units per whole token (6 dp)

/**
 * Match keeper.test.ts / flare.test.ts EXACTLY: a fresh Ledger + bootstrapped economy
 * + a FlareCreditSatellite. The AutomationEngine defaults to a sim KeeperHubClient
 * (no KEEPERHUB_API_KEY → local-only, no network) and executes every action through
 * the satellite (→ sim KeeperHub executor that always confirms). Time is controlled by
 * passing `now` (seconds) into tick(); satellite ops use `ledger.clock.now()`.
 */
function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const satellite = new FlareCreditSatellite(ledger);
  const agentId = econ.seller.agent_id;
  const engine = new AutomationEngine();
  const positions = new PositionEngine(satellite.vault, ledger, satellite.priceClient);
  return { ledger, econ, satellite, agentId, engine, positions };
}

// ---------------------------------------------------------------------------
// Registration / CRUD
// ---------------------------------------------------------------------------

test("automations: register() returns an enabled, un-fired automation with an auto- id", async () => {
  const { engine, agentId } = setup();
  const auto = await engine.register({
    agent_id: agentId,
    name: "margin-guard",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });

  assert.ok(auto.id.startsWith("auto-"), `id ${auto.id} should start with auto-`);
  assert.equal(auto.enabled, true);
  assert.equal(auto.fire_count, 0);
  assert.equal(auto.last_fired_at, undefined);
  // A non-schedule trigger has no cron, and without a KEEPERHUB_API_KEY there is no
  // remote workflow id — the automation stays purely local.
  assert.equal(auto.cron, undefined);
  assert.equal(auto.keeperhub_workflow_id, undefined);
});

test("automations: a schedule trigger renders a validated cron (60s → */1 * * * *)", async () => {
  const { engine, agentId } = setup();
  const auto = await engine.register({
    agent_id: agentId,
    name: "hourly-sweep",
    trigger: { kind: "schedule", every_seconds: 60 },
    action: { kind: "notify" },
  });

  assert.equal(auto.cron, "*/1 * * * *");
  assert.equal(auto.keeperhub_workflow_id, undefined); // no live KeeperHub key
});

test("automations: list() returns all, list(agentId) filters, get() returns a copy", async () => {
  const { engine, econ } = setup();
  const seller = econ.seller.agent_id;
  const buyer = econ.buyer.agent_id;

  const a1 = await engine.register({ agent_id: seller, name: "s1", trigger: { kind: "price_above", price: 0.4 }, action: { kind: "notify" } });
  await engine.register({ agent_id: buyer, name: "b1", trigger: { kind: "price_below", price: 0.4 }, action: { kind: "notify" } });

  assert.equal(engine.list().length, 2);
  const sellerOnly = engine.list(seller);
  assert.equal(sellerOnly.length, 1);
  assert.equal(sellerOnly[0]!.agent_id, seller);

  // get() returns a defensive copy — two reads are structurally equal but not the
  // same object reference, so callers cannot mutate the engine's internal state.
  const g1 = engine.get(a1.id);
  const g2 = engine.get(a1.id);
  assert.ok(g1 && g2);
  assert.notEqual(g1, g2);
  assert.deepEqual(g1, g2);
});

test("automations: remove() deletes and get() returns true then undefined", async () => {
  const { engine, agentId } = setup();
  const doomed = await engine.register({
    agent_id: agentId,
    name: "doomed",
    trigger: { kind: "price_above", price: 0.4 },
    action: { kind: "notify" },
  });
  assert.equal(engine.remove(doomed.id), true);
  assert.equal(engine.get(doomed.id), undefined);
  // Removing a second time is a false no-op (nothing left to delete).
  assert.equal(engine.remove(doomed.id), false);
});

test("automations: setEnabled(false) disables and a disabled automation never fires on tick", async () => {
  const { ledger, engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP); // HF ≈ 1.13 → health_below would otherwise fire

  const guard = await engine.register({
    agent_id: agentId,
    name: "margin-guard",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });

  const updated = engine.setEnabled(guard.id, false);
  assert.equal(updated?.enabled, false);
  assert.equal(engine.get(guard.id)?.enabled, false);

  // A disabled automation is skipped entirely — no run, no state change.
  const runs = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(runs.length, 0);
  assert.equal(engine.get(guard.id)?.fire_count, 0);

  // Re-enabling makes it fire again on the next tick.
  engine.setEnabled(guard.id, true);
  const runs2 = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(runs2.length, 1);
});

// ---------------------------------------------------------------------------
// Trigger evaluation + execution via tick (sim price $0.52)
// ---------------------------------------------------------------------------

test("automations: health_below FIRES, deleverages via KeeperHub, and cures HF to the 2.0 target", async () => {
  const { ledger, engine, satellite, agentId, positions } = setup();
  await satellite.draw(agentId, 8500n * FXRP); // $4,420 debt, HF ≈ 1.13

  const before = await positions.assess(agentId);
  assert.equal(before.status, "margin_call");
  assert.ok(Math.abs(before.health_factor - CAP_USD / 4420) < 0.01);

  await engine.register({
    agent_id: agentId,
    name: "margin-guard",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });

  const runs = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.fired, true);
  assert.equal(run.action, "deleverage");
  assert.ok((run.amount_fxrp ?? 0) > 0, `amount_fxrp ${run.amount_fxrp} should be > 0`);
  assert.equal(run.ok, true);
  assert.ok(run.tx_hash && run.tx_hash.length > 0, "expected a KeeperHub tx hash");
  assert.ok(run.keeperhub_audit_id, "expected a KeeperHub audit id");

  // Re-mark against the same $0.52 oracle: the cured position sits at the target HF.
  const after = await positions.assess(agentId);
  assert.equal(after.status, "healthy");
  assert.ok(Math.abs(after.health_factor - 2.0) < 0.02, `HF ${after.health_factor} should be ≈ 2.0`);
});

test("automations: price_above fires above the trigger, price_below does not (0.52 vs $0.40)", async () => {
  // price_above $0.40 → 0.52 > 0.40 → FIRES.
  {
    const { ledger, engine, satellite, agentId } = setup();
    await satellite.draw(agentId, 8500n * FXRP);
    await engine.register({
      agent_id: agentId,
      name: "price-hedge",
      trigger: { kind: "price_above", price: 0.4 },
      action: { kind: "deleverage", target_hf: 2.0 },
    });
    const runs = await engine.tick({ satellite, ledger, now: 1000 });
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.fired, true);
    assert.equal(runs[0]!.reason.includes(`$${SIM_XRP_USD}`), true);
  }

  // price_below $0.40 → 0.52 !< 0.40 → does NOT fire.
  {
    const { ledger, engine, satellite, agentId } = setup();
    await satellite.draw(agentId, 8500n * FXRP);
    await engine.register({
      agent_id: agentId,
      name: "price-floor",
      trigger: { kind: "price_below", price: 0.4 },
      action: { kind: "deleverage", target_hf: 2.0 },
    });
    const runs = await engine.tick({ satellite, ledger, now: 1000 });
    assert.equal(runs.length, 0);
  }
});

test("automations: a schedule interval fires, then respects its interval, then fires again", async () => {
  const { ledger, engine, satellite, agentId } = setup();
  const auto = await engine.register({
    agent_id: agentId,
    name: "sweep",
    trigger: { kind: "schedule", every_seconds: 100 },
    action: { kind: "notify" }, // no position needed
  });

  // First tick: last_fired undefined → due.
  const t1 = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(t1.length, 1);
  assert.equal(t1[0]!.fired, true);
  assert.equal(t1[0]!.action, "notify");

  // Second tick 50s later: 50 < 100 interval → suppressed.
  const t2 = await engine.tick({ satellite, ledger, now: 1050 });
  assert.equal(t2.length, 0);

  // Third tick 200s after the first: 200 ≥ 100 → fires again.
  const t3 = await engine.tick({ satellite, ledger, now: 1200 });
  assert.equal(t3.length, 1);

  assert.equal(engine.get(auto.id)?.fire_count, 2);
});

test("automations: cooldown suppresses a second fire within 60s on a still-unhealthy position", async () => {
  const { ledger, engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP); // HF ≈ 1.13, stays unhealthy under notify

  const auto = await engine.register({
    agent_id: agentId,
    name: "margin-alert",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "notify" }, // notify never cures the position → isolates cooldown
  });

  const first = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.fired, true);

  // Second tick 30s later — trigger STILL holds (still unhealthy) but cooldown (60s)
  // suppresses the fire, proving it is the cooldown and not the trigger.
  const second = await engine.tick({ satellite, ledger, now: 1030 });
  assert.equal(second.length, 0);
  assert.equal(engine.get(auto.id)?.fire_count, 1);
});

test("automations: once a deleverage cures the position, the health trigger no longer holds (idempotent)", async () => {
  const { ledger, engine, satellite, agentId, positions } = setup();
  await satellite.draw(agentId, 8500n * FXRP);

  const auto = await engine.register({
    agent_id: agentId,
    name: "margin-guard",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });

  const first = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(first.length, 1);
  assert.equal(first[0]!.fired, true);

  const cured = await positions.assess(agentId);
  assert.ok(Math.abs(cured.health_factor - 2.0) < 0.02);

  // Advance well past the 60s cooldown: the trigger itself (HF 2.0 < 1.4?) is false,
  // so no second deleverage runs — the automation is idempotent once cured.
  const second = await engine.tick({ satellite, ledger, now: 1100 });
  assert.equal(second.length, 0);
  assert.equal(engine.get(auto.id)?.fire_count, 1);
});

test("automations: a deleverage whose target is already met is a no-op (amount 0, ok true)", async () => {
  const { ledger, engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 2000n * FXRP); // $1,040 debt → HF ≈ 4.8, already ≥ 2.0

  // A price trigger that fires (0.52 > 0.40) but a deleverage target already satisfied.
  await engine.register({
    agent_id: agentId,
    name: "over-hedge",
    trigger: { kind: "price_above", price: 0.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });

  const runs = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(runs.length, 1);
  const run = runs[0]!;
  assert.equal(run.fired, true);
  assert.equal(run.action, "deleverage");
  assert.equal(run.amount_fxrp, 0);
  assert.equal(run.ok, true);
  assert.match(run.reason, /already at\/above target/i);
});

// ---------------------------------------------------------------------------
// Exposure safety
// ---------------------------------------------------------------------------

test("automations: a health_below deleverage reconciles the USD global exposure downward", async () => {
  const { ledger, engine, satellite, agentId } = setup();
  await satellite.draw(agentId, 8500n * FXRP);

  const before = ledger.exposure.get_agent_global_exposure(agentId)!;
  assert.equal(before.outstanding, 4_420_000_000n); // $4,420 USD micro (not FXRP units)

  await engine.register({
    agent_id: agentId,
    name: "margin-guard",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });
  const runs = await engine.tick({ satellite, ledger, now: 1000 });
  assert.equal(runs.length, 1);
  assert.equal(runs[0]!.ok, true);

  const after = ledger.exposure.get_agent_global_exposure(agentId)!;
  // Target debt for HF 2.0 = $5,000 / 2 = $2,500 → outstanding lands in a tight band
  // around $2,500 (USD micro), proving reconciliation happens in the USD denominator.
  assert.ok(after.outstanding < before.outstanding, `outstanding ${after.outstanding} should drop`);
  assert.ok(
    after.outstanding >= 2_400_000_000n && after.outstanding <= 2_600_000_000n,
    `outstanding ${after.outstanding} should be ≈ $2,500 micro`,
  );
});

// A construction-only smoke test proving the deterministic clock override wiring is
// available for time-sensitive callers (KeeperHubClient + injected clock), per the
// AutomationEngine(client, clock) contract — kept side-effect free.
test("automations: AutomationEngine accepts an injected sim KeeperHubClient + clock", () => {
  const engine = new AutomationEngine(new KeeperHubClient(), () => 1000);
  assert.ok(engine instanceof AutomationEngine);
  assert.equal(engine.list().length, 0);
});

test("automations: register() rejects unknown or incomplete triggers/actions", async () => {
  const { engine, agentId } = setup();
  // unknown trigger kind
  await assert.rejects(
    () => engine.register({ agent_id: agentId, name: "bad1", trigger: { kind: "banana" } as never, action: { kind: "notify" } }),
    /unknown trigger kind/,
  );
  // price trigger with no price
  await assert.rejects(
    () => engine.register({ agent_id: agentId, name: "bad2", trigger: { kind: "price_below" } as never, action: { kind: "notify" } }),
    /requires a positive 'price'/,
  );
  // repay action with no amount
  await assert.rejects(
    () => engine.register({ agent_id: agentId, name: "bad3", trigger: { kind: "schedule", every_seconds: 60 }, action: { kind: "repay" } as never }),
    /requires a positive 'amount_fxrp'/,
  );
  assert.equal(engine.list().length, 0); // nothing was registered
});

test("automations: concurrent ticks never double-execute the same rule", async () => {
  const { ledger, satellite, agentId, engine, positions } = setup();
  await satellite.draw(agentId, 8500n * 1_000_000n); // margin call, HF ≈ 1.13
  await engine.register({
    agent_id: agentId,
    name: "guard",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });

  const now = ledger.clock.now();
  // Fire two ticks concurrently — serialization + cooldown must let only ONE repay through.
  const [a, b] = await Promise.all([
    engine.tick({ satellite, ledger, now }),
    engine.tick({ satellite, ledger, now }),
  ]);
  const fired = [...a, ...b].filter((r) => r.action === "deleverage" && (r.amount_fxrp ?? 0) > 0);
  assert.equal(fired.length, 1, "exactly one deleverage should execute across concurrent ticks");
  assert.equal(engine.list(agentId)[0]!.fire_count, 1);

  // And the single execution cured the position.
  const after = await positions.assess(agentId);
  assert.ok(Math.abs(after.health_factor - 2.0) < 0.02, `HF ${after.health_factor} ≈ 2.0`);
});
