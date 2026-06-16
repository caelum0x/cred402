import Stripe from "stripe";
import type { RealFiBridge } from "../services/realfi_bridge.js";

/**
 * Real Stripe integration (p10) — turns genuine Stripe **test-mode** webhook
 * events into Cred402's privacy-preserving on-chain envelopes via the RealFi
 * Bridge. Uses the official `stripe` SDK for real HMAC signature verification
 * (`stripe.webhooks.constructEvent`); raw Stripe ids/PII are hashed by the bridge
 * and never stored on-chain.
 *
 * Cred402 sets these `metadata` keys when it creates the Checkout Session, so the
 * webhook can link the fiat payment back to the agent/operator:
 *   seller_agent, operator_id, service_type, request_hash, result_hash, payer_type
 *
 * Local testing:
 *   stripe listen --forward-to localhost:4021/api/realfi/stripe-webhook
 *   stripe trigger checkout.session.completed
 */
export interface StripeProcessResult {
  type: string;
  handled: boolean;
  receipt_id?: string;
  attestation_hash?: string;
  note?: string;
}

export function stripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey);
}

/**
 * Verify a raw webhook body + `Stripe-Signature` header and return the typed
 * event. Throws if the signature is invalid (real HMAC check).
 */
export function verifyStripeWebhook(
  stripe: Stripe,
  rawBody: string | Buffer,
  signatureHeader: string,
  endpointSecret: string,
): Stripe.Event {
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, endpointSecret);
}

function meta(obj: { metadata?: Stripe.Metadata | null }, key: string): string {
  return obj.metadata?.[key] ?? "";
}

/**
 * Apply a verified Stripe event to the protocol. Supported events:
 *   checkout.session.completed / charge.succeeded → on-chain fiat receipt
 *   charge.dispute.created                        → chargeback signal
 * Other events are acknowledged but not handled.
 */
export function processStripeEvent(bridge: RealFiBridge, event: Stripe.Event): StripeProcessResult {
  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object as Stripe.Checkout.Session;
      const { receipt_id } = bridge.recordFiatReceipt({
        provider: "stripe",
        provider_event_id: event.id,
        provider_receipt_id: s.id,
        payer_type: meta(s, "payer_type") || "enterprise_customer",
        seller_agent: meta(s, "seller_agent"),
        operator_id: meta(s, "operator_id"),
        amount: ((s.amount_total ?? 0) / 100).toFixed(2),
        currency: (s.currency ?? "usd").toUpperCase(),
        service_type: meta(s, "service_type") || "rwa.fiat_service",
        request_hash: meta(s, "request_hash") || "0x",
        result_hash: meta(s, "result_hash") || "0x",
        settlement_status: s.payment_status === "paid" ? "settled" : "pending",
      });
      return { type: event.type, handled: true, receipt_id };
    }
    case "charge.succeeded": {
      const c = event.data.object as Stripe.Charge;
      const { receipt_id } = bridge.recordFiatReceipt({
        provider: "stripe",
        provider_event_id: event.id,
        provider_receipt_id: c.id,
        payer_type: meta(c, "payer_type") || "enterprise_customer",
        seller_agent: meta(c, "seller_agent"),
        operator_id: meta(c, "operator_id"),
        amount: (c.amount / 100).toFixed(2),
        currency: c.currency.toUpperCase(),
        service_type: meta(c, "service_type") || "rwa.fiat_service",
        request_hash: meta(c, "request_hash") || "0x",
        result_hash: meta(c, "result_hash") || "0x",
        settlement_status: "settled",
      });
      return { type: event.type, handled: true, receipt_id };
    }
    case "charge.dispute.created": {
      const d = event.data.object as Stripe.Dispute;
      const rec = bridge.recordChargeback({
        operator_id: meta(d, "operator_id"),
        dispute_reference: d.id,
      });
      return { type: event.type, handled: true, attestation_hash: rec.attestation_hash };
    }
    default:
      return { type: event.type, handled: false, note: "acknowledged, no protocol action" };
  }
}

/** Verify + process in one step (the webhook route's core). */
export function handleStripeWebhook(args: {
  bridge: RealFiBridge;
  stripe: Stripe;
  rawBody: string | Buffer;
  signatureHeader: string;
  endpointSecret: string;
}): StripeProcessResult {
  const event = verifyStripeWebhook(args.stripe, args.rawBody, args.signatureHeader, args.endpointSecret);
  return processStripeEvent(args.bridge, event);
}
