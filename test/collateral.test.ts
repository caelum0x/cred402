import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite, PositionEngine } from "../lib/flare/index.js";
import { CollateralVault } from "../lib/flare/collateral.js";

// Deterministic sim FTSO reference prices (no FLARE_RPC_URL keys → sim path).
const SIM_XRP_USD = 0.52;
// FlareSatelliteVault default global exposure cap is $5,000 (USD).
const CAP_USD = 5000;
const FXRP = 1_000_000n; // FXRP smallest units per whole token (6 dp)

/**
 * Match keeper.test.ts / automations.test.ts EXACTLY: a fresh Ledger + bootstrapped
 * economy + a FlareCreditSatellite. The satellite exposes a shared FtsoPriceClient
 * (`priceClient`), the FXRP debt vault (`vault`) and the multi-asset collateral vault
 * (`collateral`). Everything runs on the deterministic sim FTSO — no keys, no network.
 */
function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const satellite = new FlareCreditSatellite(ledger);
  const agentId = econ.seller.agent_id;
  return { ledger, econ, satellite, agentId, now: ledger.clock.now() };
}

// ---------------------------------------------------------------------------
// CollateralVault — deposit / valuation
// ---------------------------------------------------------------------------

test("collateral: a single USDC deposit values at par and advances at its 95% LTV", async () => {
  const { satellite } = setup();
  const vault = satellite.collateral; // constructed with the satellite's FTSO client

  vault.deposit("agent", "USDC", 3000);
  const val = await vault.valueUsd("agent");

  assert.equal(val.agent_id, "agent");
  assert.equal(val.total_value_usd, 3000);
  // 3000 × 0.95 = 2850 borrowing power.
  assert.equal(val.borrowing_power_usd, 2850);

  assert.equal(val.lines.length, 1);
  const line = val.lines[0]!;
  assert.equal(line.symbol, "USDC");
  assert.equal(line.price_usd, 1);
  assert.equal(line.price_source, "sim");
  assert.equal(line.ltv_bps, 9500);
  assert.equal(line.value_usd, 3000);
  assert.equal(line.borrowing_power_usd, 2850);
});

test("collateral: a multi-asset basket sums value + LTV power and sorts lines by value desc", async () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  vault.deposit("agent", "BTC", 0.03); // $1,920 → $1,536 @ 80%
  vault.deposit("agent", "ETH", 0.5); //  $1,600 → $1,200 @ 75%
  vault.deposit("agent", "USDC", 1500); // $1,500 → $1,425 @ 95%

  const val = await vault.valueUsd("agent");

  // 1920 + 1600 + 1500 = 5020 gross.
  assert.equal(val.total_value_usd, 5020);
  // 1536 + 1200 + 1425 = 4161 borrowing power.
  assert.equal(val.borrowing_power_usd, 4161);

  // Lines sorted by value_usd descending: BTC (1920) > ETH (1600) > USDC (1500).
  assert.deepEqual(
    val.lines.map((l) => l.symbol),
    ["BTC", "ETH", "USDC"],
  );
  assert.deepEqual(
    val.lines.map((l) => l.value_usd),
    [1920, 1600, 1500],
  );
  assert.deepEqual(
    val.lines.map((l) => l.borrowing_power_usd),
    [1536, 1200, 1425],
  );
});

test("collateral: deposits of the same asset accumulate into one balance", async () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  vault.deposit("agent", "USDC", 1000);
  const second = vault.deposit("agent", "USDC", 1000);
  assert.equal(second.symbol, "USDC");
  assert.equal(second.balance_whole, 2000);

  const val = await vault.valueUsd("agent");
  assert.equal(val.lines.length, 1);
  assert.equal(val.lines[0]!.value_usd, 2000); // 2000 × $1
  assert.equal(val.total_value_usd, 2000);
});

// ---------------------------------------------------------------------------
// CollateralVault — withdrawal
// ---------------------------------------------------------------------------

test("collateral: withdraw reduces the balance, over-withdraw reverts, partial leaves a remainder", async () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  vault.deposit("agent", "USDC", 1000);

  // Over-withdraw reverts and does NOT mutate the balance.
  assert.throws(() => vault.withdraw("agent", "USDC", 1500), /insufficient/i);
  assert.equal((await vault.valueUsd("agent")).total_value_usd, 1000);

  // Partial withdraw leaves the remainder.
  const rem = vault.withdraw("agent", "USDC", 400);
  assert.equal(rem.balance_whole, 600);
  assert.equal((await vault.valueUsd("agent")).total_value_usd, 600);

  // Withdrawing the remainder empties the line entirely.
  const empty = vault.withdraw("agent", "USDC", 600);
  assert.equal(empty.balance_whole, 0);
  const val = await vault.valueUsd("agent");
  assert.equal(val.total_value_usd, 0);
  assert.deepEqual(val.lines, []); // zero-balance lines are dropped
});

// ---------------------------------------------------------------------------
// CollateralVault — validation
// ---------------------------------------------------------------------------

test("collateral: unsupported assets are rejected; isSupported is case-insensitive", async () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  assert.throws(() => vault.deposit("a", "DOGE", 1), /unsupported collateral asset/i);

  assert.equal(CollateralVault.isSupported("btc"), true); // case-insensitive
  assert.equal(CollateralVault.isSupported("BTC"), true);
  assert.equal(CollateralVault.isSupported("DOGE"), false);
});

test("collateral: non-positive / non-finite deposit amounts are rejected", () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  assert.throws(() => vault.deposit("a", "USDC", 0), /positive finite/i);
  assert.throws(() => vault.deposit("a", "USDC", -1), /positive finite/i);
  assert.throws(() => vault.deposit("a", "USDC", Number.NaN), /positive finite/i);
});

// ---------------------------------------------------------------------------
// CollateralVault — power helper + empty agent
// ---------------------------------------------------------------------------

test("collateral: borrowingPowerUsd matches valueUsd().borrowing_power_usd", async () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  vault.deposit("agent", "ETH", 0.5); // $1,600 → $1,200 @ 75%
  vault.deposit("agent", "XRP", 100); // $52 → $31.2 @ 60%

  const val = await vault.valueUsd("agent");
  const power = await vault.borrowingPowerUsd("agent");
  assert.equal(power, val.borrowing_power_usd);
});

test("collateral: an agent with no deposits values to zero with no lines", async () => {
  const { satellite } = setup();
  const vault = new CollateralVault(satellite.priceClient);

  const val = await vault.valueUsd("nobody");
  assert.equal(val.total_value_usd, 0);
  assert.equal(val.borrowing_power_usd, 0);
  assert.deepEqual(val.lines, []);
});

// ---------------------------------------------------------------------------
// PositionEngine integration — collateral expands borrowing power (additive)
// ---------------------------------------------------------------------------

test("positions+collateral: with NO collateral posted, health is unchanged from before the feature", async () => {
  const { ledger, satellite, agentId } = setup();
  // Wire the engine with the collateral vault, but post nothing.
  const engine = new PositionEngine(satellite.vault, ledger, satellite.priceClient, {}, satellite.collateral);
  await satellite.draw(agentId, 8500n * FXRP); // 8500 FXRP = $4,420 debt

  const pos = await engine.assess(agentId);

  assert.equal(pos.xrp_usd, SIM_XRP_USD);
  assert.equal(pos.price_source, "sim");
  assert.equal(pos.debt_usd, 4420);
  assert.equal(pos.cap_usd, CAP_USD);
  // No collateral → borrowing power is exactly the reputation cap; HF is cap/debt.
  assert.equal(pos.collateral_usd, 0);
  assert.equal(pos.borrowing_power_usd, CAP_USD);
  assert.ok(Math.abs(pos.health_factor - CAP_USD / 4420) < 0.01, `HF ${pos.health_factor}`); // ≈ 1.13
  assert.equal(pos.status, "margin_call");
});

test("positions+collateral: posting USDC cures the margin call with NO repay (debt unchanged)", async () => {
  const { ledger, satellite, agentId } = setup();
  const engine = new PositionEngine(satellite.vault, ledger, satellite.priceClient, {}, satellite.collateral);
  await satellite.draw(agentId, 8500n * FXRP); // $4,420 debt, HF ≈ 1.13 → margin_call

  // Baseline: margin call with no collateral.
  const before = await engine.assess(agentId);
  assert.equal(before.status, "margin_call");
  assert.equal(before.collateral_usd, 0);

  // Post $3,000 USDC → +$2,850 borrowing power (95% LTV).
  satellite.collateral.deposit(agentId, "USDC", 3000);

  const after = await engine.assess(agentId);
  assert.equal(after.collateral_usd, 2850);
  // borrowing power = cap $5,000 + collateral $2,850 = $7,850.
  assert.equal(after.borrowing_power_usd, CAP_USD + 2850);
  // HF = 7850 / 4420 ≈ 1.776.
  assert.ok(Math.abs(after.health_factor - 7850 / 4420) < 0.01, `HF ${after.health_factor}`);
  assert.equal(after.status, "healthy");
  // Collateral cured the call WITHOUT any repay — the FXRP debt is untouched.
  assert.equal(satellite.vault.debtOf(agentId), 8500n * FXRP);
  assert.equal(after.fxrp_debt, (8500n * FXRP).toString());
  assert.equal(after.deleverage_fxrp, 0); // healthy → nothing to deleverage
});

test("positions+collateral: deleverageToTarget is a no-op once collateral already meets the target", async () => {
  const { ledger, satellite, agentId } = setup();
  const engine = new PositionEngine(satellite.vault, ledger, satellite.priceClient, {}, satellite.collateral);
  await satellite.draw(agentId, 8500n * FXRP); // $4,420 debt
  satellite.collateral.deposit(agentId, "USDC", 3000); // borrowing power → $7,850, HF ≈ 1.776

  // Target HF 1.5 is already exceeded (1.776 ≥ 1.5) → no repayment required.
  const { position, deleverage_fxrp } = await engine.deleverageToTarget(agentId, 1.5);
  assert.equal(position.borrowing_power_usd, CAP_USD + 2850);
  assert.equal(deleverage_fxrp, 0);
});

test("collateral: dust amounts that round to zero units are rejected (no TypeError / no silent no-op)", () => {
  const { satellite } = setup();
  const vault = satellite.collateral;
  // USDC is 6dp → 0.0000004 rounds to 0 smallest units.
  assert.throws(() => vault.deposit("a", "USDC", 0.0000004), /rounds to zero/);
  // withdraw dust from a never-deposited agent must be a clean domain error, not a crash.
  assert.throws(() => vault.withdraw("never", "USDC", 0.0000004), /rounds to zero/);
});

test("collateral: a STALE live FTSO price contributes ZERO borrowing power (fail closed)", async () => {
  // Stub a price client that reports a stale live fallback (RPC outage).
  const staleFtso = {
    isLive: () => true,
    getPrice: async (feed: string) => ({ feed, feed_id: "0x", value: 1, decimals: 7, timestamp: 0, source: "sim" as const, stale: true }),
  };
  const vault = new CollateralVault(staleFtso as unknown as ConstructorParameters<typeof CollateralVault>[0]);
  vault.deposit("a", "USDC", 3000);
  const val = await vault.valueUsd("a");
  // Gross market value still shown, but borrowing power is zeroed so it can't inflate credit.
  assert.equal(val.total_value_usd, 3000);
  assert.equal(val.borrowing_power_usd, 0);
  assert.equal(val.lines[0]!.stale, true);
  assert.equal(val.lines[0]!.borrowing_power_usd, 0);
});
