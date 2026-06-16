import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAgentKeypair } from "../lib/x402/keys.js";
import { signPayment, verifyPayment, authorizationDigest, X402_DOMAIN, type PaymentChallenge } from "../lib/x402/x402.js";
import { paymentAuthorizationDigest } from "../lib/x402/eip712.js";

/**
 * Wires `@casper-ecosystem/casper-eip-712` — the x402 authorization is now signed
 * over a REAL EIP-712 typed-data digest (`\x19\x01`-framed keccak256), not a
 * stable-JSON string. These tests prove the digest is standards-shaped
 * (0x-prefixed 32 bytes), deterministic, field-sensitive, and that the full
 * ed25519 sign → verify round-trip holds over it.
 */

function challenge(overrides: Partial<PaymentChallenge> = {}): PaymentChallenge {
  return {
    payment_id: "pay-abc",
    amount_motes: "2000000",
    network: "casper",
    asset: "CSPR",
    resource: "/verify/energy_output?rwa_id=SOLAR-A17",
    service_type: "solar_output_verification",
    seller_agent: "EvidenceSellerAgent",
    nonce: "nonce-xyz",
    expires_at: 9_999_999_999,
    ...overrides,
  };
}

test("eip712: authorization digest is a 0x-prefixed 32-byte hash", () => {
  const auth = {
    domain: X402_DOMAIN,
    payment_id: "pay-abc",
    payer_agent: "RWARequestAgent",
    seller_agent: "EvidenceSellerAgent",
    service_type: "solar_output_verification" as const,
    amount_motes: "2000000",
    resource: "/verify/energy_output?rwa_id=SOLAR-A17",
    nonce: "nonce-xyz",
  };
  const d = paymentAuthorizationDigest(auth);
  assert.match(d, /^0x[0-9a-f]{64}$/);
  assert.equal(authorizationDigest(auth), d, "x402 uses the EIP-712 digest");
  // deterministic
  assert.equal(paymentAuthorizationDigest(auth), d);
  // field-sensitive: changing the amount changes the digest
  assert.notEqual(paymentAuthorizationDigest({ ...auth, amount_motes: "2000001" }), d);
});

test("eip712: full ed25519 sign → verify round-trip over the typed-data digest", () => {
  const buyer = generateAgentKeypair();
  const { proof } = signPayment({
    challenge: challenge(),
    payer_agent: "RWARequestAgent",
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.privatePem,
  });
  const ok = verifyPayment({ challenge: challenge(), proof, now: 1_000 });
  assert.equal(ok.ok, true, ok.reason);
});

test("eip712: a tampered amount fails verification (signature bound to the digest)", () => {
  const buyer = generateAgentKeypair();
  const { proof } = signPayment({
    challenge: challenge(),
    payer_agent: "RWARequestAgent",
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.privatePem,
  });
  // Forge the signed amount; the EIP-712 digest no longer matches the signature.
  const tampered = { ...proof, authorization: { ...proof.authorization, amount_motes: "9999999" } };
  const res = verifyPayment({ challenge: challenge({ amount_motes: "9999999" }), proof: tampered, now: 1_000 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid signature");
});
