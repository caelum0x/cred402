import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import {
  FlareSatelliteVault,
  FtsoPriceClient,
  FdcClient,
  feedIdFor,
  fxrpValueUsd,
} from "../packages/chain-adapters/src/index.js";
import { FlareCreditSatellite, ConfidentialScorer, verifyConfidentialScore } from "../lib/flare/index.js";
import type { FeatureVector } from "../lib/services/risk_engine_v2.js";
import type { CreditAuthorizationNote } from "../crosschain/standards/credit_notes.js";

const COSTON2 = "eip155:114";
const POOL = "0xf1a5ecred402vault0000000000000000000001";

// -- FTSO feed ids ----------------------------------------------------------

test("ftso: feedIdFor encodes the 21-byte crypto feed id for XRP/USD", () => {
  // 0x01 (crypto category) + ascii("XRP/USD") + right-pad to 21 bytes.
  assert.equal(feedIdFor("XRP/USD"), "0x015852502f55534400000000000000000000000000");
});

test("ftso: sim price for XRP/USD is the deterministic $0.52 reference", async () => {
  const ftso = new FtsoPriceClient();
  assert.equal(ftso.isLive(), false); // no FLARE_RPC_URL
  const price = await ftso.getPrice("XRP/USD");
  assert.equal(price.source, "sim");
  assert.equal(price.value, 0.52);
  assert.equal(price.feed, "XRP/USD");
  assert.equal(price.feed_id, "0x015852502f55534400000000000000000000000000");
});

// -- FXRP USD valuation -----------------------------------------------------

test("fassets: 500 FXRP values at exactly 260_000_000 USD micro (500 × $0.52)", async () => {
  const ftso = new FtsoPriceClient();
  const { usd_6dp, xrp_usd, source } = await fxrpValueUsd(500_000_000n, ftso); // 500 FXRP at 6 dp
  assert.equal(usd_6dp, 260_000_000n);
  assert.equal(xrp_usd, 0.52);
  assert.equal(source, "sim");
});

// -- FDC attestation --------------------------------------------------------

test("fdc: sim attestPayment returns a verified, stable attestation", async () => {
  const fdc = new FdcClient();
  assert.equal(fdc.isLive(), false); // no FLARE_FDC_VERIFIER_URL
  const req = { attestationType: "Payment" as const, sourceId: "XRP", transactionId: "0xdeadbeef" };
  const a1 = await fdc.attestPayment(req);
  assert.equal(a1.source, "sim");
  assert.equal(a1.verified, true);
  assert.equal(a1.type, "Payment");
  assert.equal(a1.source_id, "XRP");
  assert.ok(a1.attestation_id.startsWith("0x"));

  // the attestation id is deterministic for the same payment.
  const a2 = await fdc.attestPayment(req);
  assert.equal(a2.attestation_id, a1.attestation_id);
});

// -- FlareSatelliteVault ----------------------------------------------------

function vaultSetup() {
  const ledger = new Ledger();
  const agent_id = "flare-agent-1";
  ledger.agents.register_agent({ agent_id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  ledger.exposure.ensure_agent(agent_id, 1_000_000_000_000n); // generous global cap
  const vault = new FlareSatelliteVault(COSTON2, POOL, ledger.policyPublicKeyHex, 10_000_000_000n);

  const issueCan = (max_draw: bigint, asset = "FXRP"): CreditAuthorizationNote =>
    ledger.notes.issue_can({
      agent_id,
      credit_score: 80,
      risk_policy_version: 1,
      target_chain: vault.chainId,
      target_pool: vault.poolAddress,
      max_draw,
      asset,
    });

  return { ledger, agent_id, vault, issueCan, now: ledger.clock.now() };
}

test("vault: draws FXRP against a valid CAN, FTSO-priced in USD", async () => {
  const { vault, issueCan, agent_id, now } = vaultSetup();
  const can = issueCan(1_000_000_000n); // $1,000 USD limit
  const draw = await vault.draw(can, 100_000_000n, now); // 100 FXRP

  assert.equal(draw.agent_id, agent_id);
  assert.equal(draw.amount, 100_000_000n);
  assert.equal(draw.usd_6dp, 52_000_000n); // 100 × $0.52
  assert.equal(draw.xrp_usd, 0.52);
  assert.equal(draw.price_source, "sim");
  assert.ok(draw.tx_hash.startsWith("0x"));
  assert.equal(vault.debtOf(agent_id), 100_000_000n);
});

test("vault: replaying the same CAN throws 'note already consumed'", async () => {
  const { vault, issueCan, now } = vaultSetup();
  const can = issueCan(1_000_000_000n);
  await vault.draw(can, 100_000_000n, now);
  await assert.rejects(() => vault.draw(can, 100_000_000n, now), /note already consumed/);
});

test("vault: a non-FXRP CAN is rejected", async () => {
  const { vault, issueCan, now } = vaultSetup();
  const usdcCan = issueCan(1_000_000_000n, "USDC");
  await assert.rejects(() => vault.draw(usdcCan, 100_000_000n, now), /!= FXRP/);
});

test("vault: a draw whose USD value exceeds the CAN max_draw throws", async () => {
  const { vault, issueCan, now } = vaultSetup();
  const can = issueCan(10_000_000n); // only $10 authorized
  // 100 FXRP ≈ $52 > $10 → over limit.
  await assert.rejects(() => vault.draw(can, 100_000_000n, now), /USD value exceeds CAN max_draw/);
});

test("vault: repay reduces the agent's outstanding debt", async () => {
  const { vault, issueCan, agent_id, now } = vaultSetup();
  const can = issueCan(1_000_000_000n);
  await vault.draw(can, 100_000_000n, now);
  assert.equal(vault.debtOf(agent_id), 100_000_000n);

  const { remaining, usd_6dp } = await vault.repay(agent_id, 40_000_000n, now);
  assert.equal(remaining, 60_000_000n);
  assert.equal(vault.debtOf(agent_id), 60_000_000n);
  // repay is FTSO-priced so the Casper root can release exposure in USD micro.
  assert.equal(usd_6dp, 20_800_000n); // 40 FXRP × $0.52 = $20.80
});

// -- FlareCreditSatellite ---------------------------------------------------

test("satellite: draws FXRP end-to-end through Casper → FTSO → KeeperHub", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const satellite = new FlareCreditSatellite(ledger);

  const res = await satellite.draw(econ.seller.agent_id, 100n * 1_000_000n); // 100 FXRP
  assert.equal(res.ok, true);
  assert.ok(res.tx_hash.length > 0);
  assert.equal(res.price_source, "sim");
  assert.equal(res.asset, "FXRP");
  assert.equal(res.xrp_usd, 0.52);

  // a KeeperHub audit record was produced for the execution.
  assert.ok(res.keeperhub.executed);
  assert.ok(res.keeperhub.audit, "expected a KeeperHub audit record");
  assert.equal(res.keeperhub.audit!.status, "confirmed");

  const rel = satellite.reliability();
  assert.ok(rel.total >= 1);
  assert.equal(satellite.auditTrail().length, rel.total);
});

test("satellite: global exposure is reconciled in USD micro, not FXRP token units", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const agentId = econ.seller.agent_id;
  const satellite = new FlareCreditSatellite(ledger);

  // Draw 1000 FXRP @ $0.52 → $520 of USD exposure (NOT 1000 units).
  await satellite.draw(agentId, 1000n * 1_000_000n);
  const afterDraw = ledger.exposure.get_agent_global_exposure(agentId)!;
  // outstanding must be the USD value (~520_000_000 micro), never the FXRP amount.
  assert.equal(afterDraw.outstanding, 520_000_000n);
  assert.equal(afterDraw.reserved, 0n);

  // Partial repay of 600 FXRP ($312) must release exactly $312, not $600 —
  // otherwise the cross-chain over-borrow guard would be defeated when XRP/USD < $1.
  await satellite.repay(agentId, 600n * 1_000_000n);
  const afterRepay = ledger.exposure.get_agent_global_exposure(agentId)!;
  assert.equal(afterRepay.outstanding, 208_000_000n); // $520 − $312 = $208, still owed
});

test("satellite: an over-repay (amount > debt) never over-releases global exposure", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const agentId = econ.seller.agent_id;
  const satellite = new FlareCreditSatellite(ledger);

  await satellite.draw(agentId, 1000n * 1_000_000n); // $520 exposure
  // Repay far more FXRP than is owed — exposure release is capped at the debt paid.
  await satellite.repay(agentId, 5000n * 1_000_000n);
  const ex = ledger.exposure.get_agent_global_exposure(agentId)!;
  assert.equal(ex.outstanding, 0n); // fully repaid, exactly zero — never negative / over-released
});

// -- ConfidentialScorer -----------------------------------------------------

function features(): FeatureVector {
  return {
    reputation: 0.9,
    accuracy: 0.85,
    dispute_rate: 0.05,
    experience: 0.6,
    revenue: 0.4242, // distinctive value to prove it is never published
    stake: 0.5,
    category_risk: 0.7,
  };
}

test("confidential: score publishes an attestation with no raw feature values", async () => {
  const scorer = new ConfidentialScorer({ now: () => 1_700_000_000 });
  const att = await scorer.score("agent-x", features());

  assert.equal(att.type, "Cred402ConfidentialScoreAttestation");
  assert.equal(att.agent_id, "agent-x");
  assert.equal(att.enclave.platform, "sim-tee");
  assert.equal(att.enclave.verified, true);
  assert.equal(att.produced_at, 1_700_000_000);
  assert.ok(att.score >= 0 && att.score <= 100);
  assert.ok(att.input_commitment.startsWith("0x") || att.input_commitment.length > 0);

  // the published envelope must not leak any raw feature: no `features` key and
  // no distinctive feature value anywhere in the serialized object.
  assert.equal((att as unknown as Record<string, unknown>).features, undefined);
  assert.ok(!JSON.stringify(att).includes("0.4242"), "raw feature value leaked into the attestation");
});

test("confidential: verify passes for the true features and fails for mutated ones", async () => {
  const scorer = new ConfidentialScorer({ now: () => 1_700_000_000 });
  const f = features();
  const att = await scorer.score("agent-x", f);

  assert.deepEqual(verifyConfidentialScore(att, f), { ok: true });

  const mutated: FeatureVector = { ...f, revenue: 0.9999 };
  const bad = verifyConfidentialScore(att, mutated);
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? "", /input commitment mismatch/);
});
