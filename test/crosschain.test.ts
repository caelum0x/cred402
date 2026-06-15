import { test } from "node:test";
import assert from "node:assert/strict";

import {
  makeCaid,
  parseCaid,
  makeUaid,
  parseUaid,
  buildAddressBinding,
  verifyAddressBinding,
  buildUniversalReceipt,
  verifyUniversalReceipt,
  buildCreditAuthorizationNote,
  verifyCreditAuthorizationNote,
  validateAgainstSchema,
} from "../crosschain/standards/index.js";
import { generateAgentKeypair } from "../lib/x402/keys.js";
import { generateEvmKeypair } from "../lib/x402/evm.js";

test("CAID round-trips and rejects malformed ids", () => {
  const caid = makeCaid("weather-risk-agent-01");
  assert.equal(caid, "cred402:casper:weather-risk-agent-01");
  assert.equal(parseCaid(caid).agent_id, "weather-risk-agent-01");
  assert.throws(() => parseCaid("not-a-caid"));
});

test("UAID is deterministic and parseable", () => {
  const input = { asset_type: "solar-receivable", jurisdiction: "TR", issuer_hash: "0xabc", document_bundle_hash: "0xdef", salt: "s1" };
  const a = makeUaid(input);
  const b = makeUaid(input);
  assert.equal(a, b);
  assert.equal(parseUaid(a).asset_type, "solar-receivable");
});

test("ABE: dual ed25519+secp256k1 signatures verify; tampering fails", () => {
  const casper = generateAgentKeypair();
  const evm = generateEvmKeypair();
  const abe = buildAddressBinding({
    agent_id: "weather-risk-agent-01",
    casper_account: casper.publicKeyHex,
    casper_private_pem: casper.privatePem,
    external_chain: "eip155:8453",
    external_address: evm.address,
    external_private_key: evm.privateKey,
    expires_at: 99_999_999_999,
  });
  assert.equal(verifyAddressBinding(abe, 1_700_000_000).ok, true);
  assert.equal(validateAgainstSchema("address_binding", abe).ok, true);

  // tamper the external address -> external signature no longer recovers it
  const tampered = { ...abe, external_address: "0x0000000000000000000000000000000000000001" };
  assert.equal(verifyAddressBinding(tampered, 1_700_000_000).ok, false);

  // expired
  assert.equal(verifyAddressBinding(abe, 100_000_000_000).ok, false);
});

test("URE: canonical receipt id recomputes and validates against schema", () => {
  const { envelope, receipt_id } = buildUniversalReceipt({
    origin_chain: "eip155:8453",
    settlement_network: "base",
    payer_agent_id: "rwa-request-agent-01",
    seller_agent_id: "weather-risk-agent-01",
    payer_address: "0x1111111111111111111111111111111111111111",
    seller_address: "0x2222222222222222222222222222222222222222",
    asset: "USDC",
    amount: "40000",
    service_type: "rwa.weather_risk",
    request_hash: "0xreq",
    result_hash: "0xres",
    payment_proof_hash: "0xproof",
    settlement_tx_hash: "0xtx",
    nonce: "0xnonce",
    created_at: 1_780_000_000,
  });
  assert.match(receipt_id, /^0x[0-9a-f]{64}$/);
  assert.equal(verifyUniversalReceipt(envelope, receipt_id).ok, true);
  assert.equal(verifyUniversalReceipt(envelope, "0xwrong").ok, false);
  assert.equal(validateAgainstSchema("universal_receipt", envelope).ok, true);
});

test("CAN: casper-policy signature verifies; expiry + wrong target rejected", () => {
  const policy = generateAgentKeypair();
  const can = buildCreditAuthorizationNote(
    {
      agent_id: "weather-risk-agent-01",
      target_chain: "eip155:8453",
      target_pool: "0xPool00000000000000000000000000000000Pool",
      max_draw: "500000000",
      asset: "USDC",
      credit_score: 82,
      risk_policy_version: 3,
      global_exposure_after_draw: "1200000000",
      expires_at: 99_999_999_999,
      nonce: "0xnonce",
    },
    policy.privatePem,
  );
  const ctx = { now: 1_700_000_000, target_chain: "eip155:8453", target_pool: "0xPool00000000000000000000000000000000Pool" };
  assert.equal(verifyCreditAuthorizationNote(can, policy.publicKeyHex, ctx).ok, true);
  assert.equal(validateAgainstSchema("credit_authorization_note", can).ok, true);

  // wrong pool
  assert.equal(verifyCreditAuthorizationNote(can, policy.publicKeyHex, { ...ctx, target_pool: "0xdead" }).ok, false);
  // expired
  assert.equal(verifyCreditAuthorizationNote(can, policy.publicKeyHex, { ...ctx, now: 100_000_000_000 }).ok, false);
  // wrong signer
  const other = generateAgentKeypair();
  assert.equal(verifyCreditAuthorizationNote(can, other.publicKeyHex, ctx).ok, false);
});

test("schema validation rejects malformed envelopes", () => {
  const bad = { type: "Cred402Receipt", version: "1", amount: "not-a-number" };
  const res = validateAgainstSchema("universal_receipt", bad);
  assert.equal(res.ok, false);
  assert.ok(res.errors.length > 0);
});
