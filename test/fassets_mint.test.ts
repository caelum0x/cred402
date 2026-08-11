import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/index.js";
import { FAssetsMinter } from "../lib/flare/fassets_mint.js";
import { fxrpToXrp } from "../packages/chain-adapters/src/index.js";

// FXRP mirrors XRP: 6 dp. 5000 XRP = 5_000_000_000n drops.
const FIVE_K_XRP = 5000_000000n; // 5_000_000_000n
const RESERVATION_TTL_SEC = 24 * 3600; // 86_400
// Deterministic sim FTSO reference price (no keys → sim path).
const SIM_XRP_USD = 0.52;

// ---------------------------------------------------------------------------
// FAssetsMinter — reserve
// ---------------------------------------------------------------------------

test("fassets: reserveMinting quotes 1:1 FXRP, a 0.25% fee, and a 24h TTL", () => {
  const minter = new FAssetsMinter({ now: () => 1000 });
  const r = minter.reserveMinting("a", FIVE_K_XRP);

  assert.equal(r.status, "reserved");
  assert.equal(r.agent_id, "a");
  assert.equal(r.underlying_drops, "5000000000");
  assert.equal(r.fxrp_amount, "5000000000"); // 1:1 with the underlying
  // 0.25% of 5_000_000_000 = 12_500_000.
  assert.equal(r.reservation_fee_drops, "12500000");
  assert.ok(r.payment_address.length > 0, "payment_address is non-empty");
  assert.ok(r.reservation_id.length > 0, "reservation_id is non-empty");
  assert.equal(r.created_at, 1000);
  assert.equal(r.expires_at, 1000 + RESERVATION_TTL_SEC);
  assert.equal(r.expires_at, r.created_at + RESERVATION_TTL_SEC);
});

test("fassets: reserveMinting rejects non-positive amounts", () => {
  const minter = new FAssetsMinter({ now: () => 0 });
  assert.throws(() => minter.reserveMinting("a", 0n), /positive/);
  assert.throws(() => minter.reserveMinting("a", -1n), /positive/);
});

// ---------------------------------------------------------------------------
// FAssetsMinter — execute
// ---------------------------------------------------------------------------

test("fassets: executeMinting mints FXRP 1:1 with an FDC-attested (sim) proof", async () => {
  const minter = new FAssetsMinter({ now: () => 1000 });
  const r = minter.reserveMinting("a", FIVE_K_XRP);

  const res = await minter.executeMinting(r.reservation_id, "xrpltx");

  assert.equal(res.agent_id, "a");
  assert.equal(res.asset, "FXRP");
  assert.equal(res.fxrp_minted, "5000000000");
  assert.equal(res.fxrp_balance, "5000000000");
  assert.equal(res.xrpl_tx_hash, "xrpltx");
  assert.equal(res.fdc_verified, true);
  assert.equal(res.fdc_source, "sim");
  assert.ok(res.fdc_attestation_id.length > 0, "fdc_attestation_id is non-empty");

  // Reservation transitions to "minted" and the balance credits 1:1.
  assert.equal(minter.balanceOf("a"), FIVE_K_XRP);
  assert.equal(minter.reservationsFor("a")[0]!.status, "minted");
});

test("fassets: executeMinting on an unknown reservation reverts", async () => {
  const minter = new FAssetsMinter({ now: () => 0 });
  await assert.rejects(() => minter.executeMinting("cr-nope", "tx"), /unknown reservation/);
});

test("fassets: executeMinting is idempotent-guarded — a second mint of the same reservation reverts", async () => {
  const minter = new FAssetsMinter({ now: () => 0 });
  const r = minter.reserveMinting("a", FIVE_K_XRP);
  await minter.executeMinting(r.reservation_id, "tx");

  await assert.rejects(() => minter.executeMinting(r.reservation_id, "tx"), /already minted/);
  // The double attempt must not double-credit the balance.
  assert.equal(minter.balanceOf("a"), FIVE_K_XRP);
});

test("fassets: a reservation expires after its TTL and executeMinting reverts + marks it expired", async () => {
  let T = 1000;
  const minter = new FAssetsMinter({ now: () => T });
  const r = minter.reserveMinting("a", FIVE_K_XRP);
  assert.equal(r.status, "reserved");

  // Jump one second past the 24h TTL.
  T = 1000 + RESERVATION_TTL_SEC + 1;
  await assert.rejects(() => minter.executeMinting(r.reservation_id, "tx"), /expired/);

  // The reservation is now persisted as "expired" and nothing was minted.
  assert.equal(minter.reservationsFor("a")[0]!.status, "expired");
  assert.equal(minter.balanceOf("a"), 0n);
});

// ---------------------------------------------------------------------------
// FAssetsMinter — mint convenience + supply
// ---------------------------------------------------------------------------

test("fassets: mint() reserves+executes in one and totalSupply sums across agents", async () => {
  const minter = new FAssetsMinter({ now: () => 0 });

  await minter.mint("a", 3000_000000n);
  assert.equal(minter.balanceOf("a"), 3000_000000n);

  await minter.mint("b", 2000_000000n);
  assert.equal(minter.balanceOf("b"), 2000_000000n);

  // A second mint for "a" grows its balance.
  await minter.mint("a", 1000_000000n);
  assert.equal(minter.balanceOf("a"), 4000_000000n);

  // totalSupply = 4000 + 2000 = 6000 FXRP.
  assert.equal(minter.totalSupply(), 6000_000000n);
  assert.equal(
    minter.totalSupply(),
    minter.balanceOf("a") + minter.balanceOf("b"),
  );
});

// ---------------------------------------------------------------------------
// FAssetsMinter — redeem
// ---------------------------------------------------------------------------

test("fassets: redeem burns FXRP 1:1 and opens an XRPL redemption ticket", async () => {
  const minter = new FAssetsMinter({ now: () => 0 });
  await minter.mint("a", FIVE_K_XRP);

  const red = minter.redeem("a", 1000_000000n);

  assert.equal(red.agent_id, "a");
  assert.equal(red.fxrp_burned, "1000000000");
  assert.equal(red.underlying_drops, "1000000000"); // 1:1 back to XRP
  assert.ok(red.xrpl_redemption_ticket.length > 0, "xrpl_redemption_ticket is non-empty");

  // Balance decreases by exactly the burned amount.
  assert.equal(minter.balanceOf("a"), FIVE_K_XRP - 1000_000000n);
  assert.equal(red.fxrp_balance, (FIVE_K_XRP - 1000_000000n).toString());
});

test("fassets: redeem rejects over-balance and non-positive amounts", async () => {
  const minter = new FAssetsMinter({ now: () => 0 });
  await minter.mint("a", 1000_000000n);

  assert.throws(() => minter.redeem("a", 2000_000000n), /insufficient/);
  assert.throws(() => minter.redeem("a", 0n), /positive/);
  assert.throws(() => minter.redeem("a", -5n), /positive/);
  // Failed redemptions leave the balance untouched.
  assert.equal(minter.balanceOf("a"), 1000_000000n);
});

// ---------------------------------------------------------------------------
// FAssetsMinter — reservationsFor filter + totalSupply invariant
// ---------------------------------------------------------------------------

test("fassets: reservationsFor filters by agent and totalSupply equals the sum of balances", async () => {
  const minter = new FAssetsMinter({ now: () => 0 });

  minter.reserveMinting("a", 1000_000000n);
  minter.reserveMinting("a", 2000_000000n);
  minter.reserveMinting("b", 3000_000000n);

  assert.equal(minter.reservationsFor("a").length, 2);
  assert.equal(minter.reservationsFor("b").length, 1);
  assert.ok(minter.reservationsFor("a").every((r) => r.agent_id === "a"));
  assert.equal(minter.reservationsFor().length, 3); // no filter → all

  // Only "a"'s two reservations are executed → supply reflects exactly those.
  for (const r of minter.reservationsFor("a")) {
    await minter.executeMinting(r.reservation_id, "tx-" + r.reservation_id);
  }
  assert.equal(minter.balanceOf("a"), 3000_000000n);
  assert.equal(minter.balanceOf("b"), 0n);
  assert.equal(minter.totalSupply(), minter.balanceOf("a") + minter.balanceOf("b"));
});

// ---------------------------------------------------------------------------
// Mint → collateralize integration (the interoperable-asset loop)
// ---------------------------------------------------------------------------

test("fassets→collateral: minted FXRP becomes FTSO-priced borrowing power", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const satellite = new FlareCreditSatellite(ledger);
  const seller = econ.seller.agent_id;

  const minter = new FAssetsMinter({ now: () => 0 });
  const minted = await minter.mint(seller, FIVE_K_XRP);
  assert.equal(minted.fxrp_minted, "5000000000");

  // Post the freshly minted FXRP as XRP collateral (whole units).
  const wholeXrp = fxrpToXrp(minter.balanceOf(seller)); // 5000
  assert.equal(wholeXrp, 5000);
  satellite.collateral.deposit(seller, "XRP", wholeXrp);

  const val = await satellite.collateral.valueUsd(seller);
  // 5000 XRP × $0.52 = $2,600 gross value.
  assert.equal(val.total_value_usd, 5000 * SIM_XRP_USD); // 2600
  assert.equal(val.total_value_usd, 2600);
  // $2,600 × 60% XRP LTV = $1,560 borrowing power.
  assert.equal(val.borrowing_power_usd, 1560);

  const line = val.lines[0]!;
  assert.equal(line.symbol, "XRP");
  assert.equal(line.price_usd, SIM_XRP_USD);
  assert.equal(line.price_source, "sim");
  assert.equal(line.ltv_bps, 6000);
});

test("minter: debit locks FXRP out of the wallet (no double-count when collateralizing)", async () => {
  const m = new FAssetsMinter();
  await m.mint("a", 5000n * 1_000_000n);
  assert.equal(m.balanceOf("a"), 5000n * 1_000_000n);
  // Posting as collateral debits the wallet — the same FXRP can't be counted twice.
  m.debit("a", 5000n * 1_000_000n);
  assert.equal(m.balanceOf("a"), 0n);
  assert.throws(() => m.debit("a", 1n), /insufficient FXRP/);
  assert.throws(() => m.debit("a", 0n), /positive/);
  assert.equal(m.totalSupply(), 0n);
});

test("minter: concurrent executeMinting on one reservation mints exactly once (no double-mint)", async () => {
  const m = new FAssetsMinter();
  const r = m.reserveMinting("a", 1_000_000n); // 1 XRP
  // Two concurrent executions of the SAME reservation — only one may credit FXRP.
  const results = await Promise.allSettled([
    m.executeMinting(r.reservation_id, "xrpltx"),
    m.executeMinting(r.reservation_id, "xrpltx"),
  ]);
  const fulfilled = results.filter((x) => x.status === "fulfilled");
  const rejected = results.filter((x) => x.status === "rejected");
  assert.equal(fulfilled.length, 1, "exactly one executeMinting should succeed");
  assert.equal(rejected.length, 1, "the racing executeMinting must be rejected");
  assert.equal(m.balanceOf("a"), 1_000_000n); // 1 FXRP, not 2 — backed by one 1 XRP deposit
  assert.equal(m.totalSupply(), 1_000_000n);
});
