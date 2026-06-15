import { test } from "node:test";
import assert from "node:assert/strict";

import { cspr, formatCspr } from "../lib/core/units.js";
import { blake2b256, hashObject } from "../lib/core/hash.js";
import { policyV1, policyV2 } from "../lib/core/risk_policy.js";
import type { Agent } from "../lib/core/types.js";
import {
  generateAgentKeypair,
  signPayment,
  verifyPayment,
  type PaymentChallenge,
} from "../lib/x402/index.js";
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";

test("units: cspr <-> motes round-trips", () => {
  assert.equal(cspr(1).toString(), "1000000000");
  assert.equal(cspr("0.002").toString(), "2000000");
  assert.equal(formatCspr(cspr("12.5")), "12.5");
  assert.equal(formatCspr(1_000_000_000n), "1");
});

test("hash: deterministic + 0x-prefixed 256-bit", () => {
  const h = blake2b256("cred402");
  assert.match(h, /^0x[0-9a-f]{64}$/);
  assert.equal(hashObject({ a: 1, b: 2 }), hashObject({ b: 2, a: 1 }));
  assert.notEqual(blake2b256("a"), blake2b256("b"));
});

test("x402: a valid payment proof verifies, a tampered one fails", () => {
  const keys = generateAgentKeypair();
  const challenge: PaymentChallenge = {
    payment_id: "pay-1",
    amount_motes: cspr("0.002").toString(),
    network: "casper",
    asset: "CSPR",
    resource: "/verify/energy_output",
    service_type: "solar_output_verification",
    seller_agent: "Seller",
    nonce: "nonce-1",
    expires_at: 9999999999,
  };
  const { proof } = signPayment({
    challenge,
    payer_agent: "Buyer",
    payer_public_key: keys.publicKeyHex,
    payer_private_pem: keys.privatePem,
  });
  assert.equal(verifyPayment({ challenge, proof }).ok, true);

  // tamper the amount -> signature no longer matches
  const tampered = { ...proof, authorization: { ...proof.authorization, amount_motes: cspr(999).toString() } };
  assert.equal(verifyPayment({ challenge, proof: tampered }).ok, false);
});

function sampleAgent(): Agent {
  const now = Math.floor(Date.now() / 1000);
  return {
    agent_id: "A",
    owner_public_key: "01ab",
    agent_public_key: "01ab",
    service_type: "solar_output_verification",
    stake: cspr(50),
    total_jobs_completed: 412,
    x402_revenue_history: Array.from({ length: 100 }, (_, i) => ({
      receipt_id: `r${i}`,
      amount: cspr("1.28"),
      timestamp: now - i * 1000,
      service_type: "solar_output_verification",
    })),
    accuracy_score: 94,
    dispute_rate: 0.017,
    reputation_score: 91,
    credit_score: 0,
    active: true,
    registered_at: now,
  };
}

test("risk policy: v1 produces a positive credit line and sane interest", () => {
  const now = Math.floor(Date.now() / 1000);
  const d = policyV1(sampleAgent(), now);
  assert.ok(d.credit_line > 0n, "credit line should be positive");
  assert.ok(d.credit_score > 80 && d.credit_score <= 100);
  assert.ok(d.interest_rate_bps >= 800 && d.interest_rate_bps <= 2200);
});

test("risk policy: v2 rewards throughput vs v1", () => {
  const now = Math.floor(Date.now() / 1000);
  const a = sampleAgent();
  const v1 = policyV1(a, now).credit_line;
  const v2 = policyV2(a, now).credit_line;
  assert.ok(v2 > v1, "v2 should grant more to a high-throughput agent");
});

test("economy: full honest loop opens a credit line and finalizes receipts", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  assert.equal(reports.length, 3);
  const audit = await econ.runWatchdogAudit(reports);
  assert.equal(audit.disputed, false);
  econ.scoreJob();
  const { creditLineMotes } = econ.underwriteSeller();
  assert.ok(creditLineMotes > 0n);

  const line = econ.ledger.pool.get(econ.seller.agent_id)!;
  assert.equal(line.status, "active");
  const finalized = econ.ledger.receipts.list().filter((r) => r.status === "finalized");
  assert.equal(finalized.length, 3);
});

test("economy: tampered evidence triggers dispute, slash and freeze", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const stakeBefore = econ.ledger.agents.get(econ.seller.agent_id)!.stake;
  const { reports } = await econ.runEvidencePurchases({ tamperEnergy: true });
  const audit = await econ.runWatchdogAudit(reports);
  assert.equal(audit.disputed, true);

  const seller = econ.ledger.agents.get(econ.seller.agent_id)!;
  assert.ok(seller.stake < stakeBefore, "stake should be slashed");
  const disputed = econ.ledger.receipts.list().some((r) => r.status === "disputed");
  assert.equal(disputed, true);
});

test("ledger: upgradable policy swaps v1 -> v2 and emits event", () => {
  const ledger = new Ledger();
  assert.equal(ledger.policy.version(), "v1");
  ledger.policy.upgrade("v2");
  assert.equal(ledger.policy.version(), "v2");
  assert.ok(ledger.bus.all().some((e) => e.name === "PolicyUpgraded"));
});
