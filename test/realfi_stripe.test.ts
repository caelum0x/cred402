import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import { stripeClient, handleStripeWebhook, processStripeEvent } from "../lib/realfi/stripe.js";

/**
 * p10 — real Stripe webhook integration. Uses the official `stripe` SDK to
 * generate a REAL signed webhook header (`generateTestHeaderString`) and verify
 * it (`constructEvent`) — genuine HMAC crypto, no live Stripe account — then maps
 * the verified event into a privacy-preserving on-chain fiat receipt. PII/raw ids
 * are hashed by the bridge; nothing sensitive is committed.
 */
const SECRET = "whsec_test_cred402_p10";

function signedEvent(stripe: ReturnType<typeof stripeClient>, payloadObj: unknown): { body: string; sig: string } {
  const body = JSON.stringify(payloadObj);
  const sig = stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET });
  return { body, sig };
}

test("p10 stripe: a real signed checkout.session.completed becomes an on-chain fiat receipt", () => {
  const bridge = new RealFiBridge(new Ledger());
  const stripe = stripeClient("sk_test_dummy");
  const { body, sig } = signedEvent(stripe, {
    id: "evt_test_123",
    object: "event",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_abc",
        object: "checkout.session",
        amount_total: 10000, // $100.00
        currency: "usd",
        payment_status: "paid",
        metadata: {
          seller_agent: "WeatherRiskAgent",
          operator_id: "operator:0xabc",
          service_type: "rwa.weather_risk",
          payer_type: "enterprise_customer",
        },
      },
    },
  });

  const res = handleStripeWebhook({ bridge, stripe, rawBody: body, signatureHeader: sig, endpointSecret: SECRET });
  assert.equal(res.handled, true);
  assert.equal(res.type, "checkout.session.completed");
  assert.ok(res.receipt_id, "an on-chain fiat receipt id was produced");
});

test("p10 stripe: an invalid signature is rejected (real HMAC verification)", () => {
  const bridge = new RealFiBridge(new Ledger());
  const stripe = stripeClient("sk_test_dummy");
  const body = JSON.stringify({ id: "evt_x", type: "charge.succeeded", data: { object: {} } });
  assert.throws(
    () => handleStripeWebhook({ bridge, stripe, rawBody: body, signatureHeader: "t=1,v1=deadbeef", endpointSecret: SECRET }),
    /signature/i,
  );
});

test("p10 stripe: charge.dispute.created records a chargeback signal", () => {
  const bridge = new RealFiBridge(new Ledger());
  const res = processStripeEvent(bridge, {
    id: "evt_dispute",
    type: "charge.dispute.created",
    // minimal shape — processStripeEvent reads .data.object + metadata
    data: { object: { id: "dp_1", metadata: { operator_id: "operator:0xabc" } } },
  } as never);
  assert.equal(res.handled, true);
  assert.ok(res.attestation_hash);
});

test("p10 stripe: unrelated events are acknowledged, not actioned", () => {
  const bridge = new RealFiBridge(new Ledger());
  const res = processStripeEvent(bridge, {
    id: "evt_ping",
    type: "customer.created",
    data: { object: {} },
  } as never);
  assert.equal(res.handled, false);
});
