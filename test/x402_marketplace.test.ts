import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { CreditServiceMarketplace, CREDIT_SERVICES, type MarketplaceCall } from "../lib/services/x402_marketplace.js";
import { signPayment, type ReceiptCommitment } from "../lib/x402/index.js";
import type { BaseAgent } from "../agents/base_agent.js";

/**
 * x402 Credit-Service Marketplace — production-grade unit tests.
 *
 * The whole flow is in-process: no network, no env keys. A 402 challenge is
 * signed with the buyer agent's real ed25519 key (`Cred402Economy.buyer`) and
 * verified by Cred402's built-in {@link X402Gateway}. Setup mirrors
 * collateral.test.ts: `new Ledger()` → `new Cred402Economy(ledger)` → `.bootstrap()`.
 */

// 0.005 CSPR = 5_000_000 motes; 0.008 CSPR = 8_000_000 motes.
const CREDIT_CHECK_MOTES = "5000000";
const RISK_SCORE_MOTES = "8000000";

/** Deterministic runner stub: echoes the service id + the caller's agent_id. */
function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const runner = async (id: string, params: Record<string, unknown>) => ({ ran: id, agent_id: params.agent_id });
  const market = new CreditServiceMarketplace(econ.seller.agent_id, runner);
  return { ledger, econ, market, buyer: econ.buyer, seller: econ.seller.agent_id };
}

/**
 * Drive the full x402 handshake for one call: 402 challenge → sign with the
 * buyer's key → retry with the `X-Payment` header. Returns the terminal
 * MarketplaceCall (paid, or an earlier rejection/challenge if the flow short-circuits).
 */
async function buy(
  market: CreditServiceMarketplace,
  buyer: BaseAgent,
  serviceId: string,
  params: Record<string, unknown>,
): Promise<MarketplaceCall> {
  const challenged = await market.call(serviceId, undefined, params);
  if (challenged.kind !== "challenge") return challenged;
  const challenge = (challenged.body as { challenge: Parameters<typeof signPayment>[0]["challenge"] }).challenge;
  const { header } = signPayment({
    challenge,
    payer_agent: buyer.agent_id,
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.keys.privatePem,
  });
  return market.call(serviceId, header, params);
}

// ---------------------------------------------------------------------------
// Discovery catalog
// ---------------------------------------------------------------------------

test("marketplace: listings() exposes all 5 credit services with resource + zeroed counters", () => {
  const { market } = setup();
  const listings = market.listings();

  assert.equal(listings.length, CREDIT_SERVICES.length);
  assert.equal(listings.length, 5);
  assert.deepEqual(
    listings.map((l) => l.id).sort(),
    ["confidential-score", "credit-check", "position-health", "risk-score", "underwrite"],
  );

  const check = listings.find((l) => l.id === "credit-check")!;
  assert.equal(check.resource, "/x402/services/credit-check");
  assert.equal(check.price_motes, CREDIT_CHECK_MOTES); // 0.005 CSPR
  assert.equal(check.calls, 0);
  assert.equal(check.revenue_motes, "0");

  // Every listing starts with a zeroed ledger and a well-formed resource path.
  for (const l of listings) {
    assert.equal(l.resource, `/x402/services/${l.id}`);
    assert.equal(l.calls, 0);
    assert.equal(l.revenue_motes, "0");
    assert.ok(BigInt(l.price_motes) > 0n, `${l.id} has a positive price`);
  }
});

// ---------------------------------------------------------------------------
// Rejections — validated BEFORE any payment is taken
// ---------------------------------------------------------------------------

test("marketplace: an unknown service is rejected 404 with no challenge", async () => {
  const { market } = setup();
  const res = await market.call("nope", undefined, {});
  assert.equal(res.kind, "rejected");
  assert.equal((res as Extract<MarketplaceCall, { kind: "rejected" }>).status, 404);
  assert.match((res as Extract<MarketplaceCall, { kind: "rejected" }>).body.error, /unknown service: nope/);
});

test("marketplace: missing required params is rejected 400 BEFORE issuing a 402 challenge", async () => {
  const { market } = setup();
  const res = await market.call("credit-check", undefined, {});

  assert.equal(res.kind, "rejected");
  const rej = res as Extract<MarketplaceCall, { kind: "rejected" }>;
  assert.equal(rej.status, 400);
  // The error must name the missing param so the caller can fix it.
  assert.match(rej.body.error, /missing required params/);
  assert.match(rej.body.error, /agent_id/);

  // Params are validated before charging → no challenge was minted, revenue stays 0.
  assert.equal(market.stats().total_calls, 0);
  assert.equal(market.listings().find((l) => l.id === "credit-check")!.calls, 0);
});

// ---------------------------------------------------------------------------
// 402 challenge shape
// ---------------------------------------------------------------------------

test("marketplace: a valid unpaid request returns a 402 challenge for the seller at the right price", async () => {
  const { market, seller } = setup();
  const res = await market.call("credit-check", undefined, { agent_id: "x" });

  assert.equal(res.kind, "challenge");
  const ch = res as Extract<MarketplaceCall, { kind: "challenge" }>;
  assert.equal(ch.status, 402);

  const challenge = (ch.body as { challenge: any }).challenge;
  assert.ok(challenge, "402 body carries the signed challenge");
  assert.equal(challenge.amount_motes, CREDIT_CHECK_MOTES); // 0.005 CSPR = 5_000_000 motes
  assert.equal(challenge.seller_agent, seller);
  assert.equal(challenge.resource, "/x402/services/credit-check");
  assert.equal(challenge.asset, "CSPR");
  assert.ok(typeof challenge.payment_id === "string" && challenge.payment_id.length > 0);
  assert.ok(typeof challenge.nonce === "string" && challenge.nonce.length > 0);
});

// ---------------------------------------------------------------------------
// Full pay flow
// ---------------------------------------------------------------------------

test("marketplace: signing the challenge settles the call, returns a receipt + the runner result", async () => {
  const { market, buyer } = setup();
  const res = await buy(market, buyer, "credit-check", { agent_id: "x" });

  assert.equal(res.kind, "paid");
  const paid = res as Extract<MarketplaceCall, { kind: "paid" }>;
  assert.equal(paid.status, 200);
  assert.equal(paid.payer_agent, buyer.agent_id);

  // Receipt commitment.
  assert.ok(paid.receipt.receipt_id, "receipt has an id");
  assert.equal(paid.receipt.amount_motes, CREDIT_CHECK_MOTES);
  assert.equal(paid.receipt.payer_agent, buyer.agent_id);
  assert.equal(paid.receipt.resource, "/x402/services/credit-check");

  // The runner ran with the caller's params.
  assert.deepEqual(paid.result, { ran: "credit-check", agent_id: "x" });

  // Counters reflect exactly one settled call.
  assert.equal(market.stats().total_calls, 1);
  assert.equal(market.listings().find((l) => l.id === "credit-check")!.calls, 1);
});

// ---------------------------------------------------------------------------
// Replay protection
// ---------------------------------------------------------------------------

test("marketplace: replaying the SAME signed header a second time is rejected (nonce/proof consumed)", async () => {
  const { market, buyer } = setup();

  // First pass: obtain a challenge, sign it, settle it.
  const challenged = await market.call("credit-check", undefined, { agent_id: "x" });
  assert.equal(challenged.kind, "challenge");
  const challenge = (challenged as Extract<MarketplaceCall, { kind: "challenge" }>).body as { challenge: any };
  const { header } = signPayment({
    challenge: challenge.challenge,
    payer_agent: buyer.agent_id,
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.keys.privatePem,
  });

  const first = await market.call("credit-check", header, { agent_id: "x" });
  assert.equal(first.kind, "paid");

  // Reusing the identical header must be rejected — the challenge/nonce/proof are single-use.
  const replay = await market.call("credit-check", header, { agent_id: "x" });
  assert.equal(replay.kind, "rejected");
  assert.ok((replay as Extract<MarketplaceCall, { kind: "rejected" }>).status >= 400);

  // Replay earns nothing: still exactly one settled call.
  assert.equal(market.stats().total_calls, 1);
  assert.equal(market.receiptLog().length, 1);
});

// ---------------------------------------------------------------------------
// Stats / revenue rollup across services
// ---------------------------------------------------------------------------

test("marketplace: stats() rolls up call count + revenue across distinct services", async () => {
  const { market, buyer } = setup();

  const a = await buy(market, buyer, "credit-check", { agent_id: "x" }); // 0.005 CSPR
  const b = await buy(market, buyer, "risk-score", { agent_id: "x" }); //   0.008 CSPR
  assert.equal(a.kind, "paid");
  assert.equal(b.kind, "paid");

  const stats = market.stats();
  assert.equal(stats.total_calls, 2);
  // 5_000_000 + 8_000_000 = 13_000_000 motes.
  assert.equal(stats.total_revenue_motes, "13000000");
  assert.equal(stats.by_service["credit-check"], 1);
  assert.equal(stats.by_service["risk-score"], 1);

  assert.equal(market.receiptLog().length, 2);

  // Per-service listing counters agree with the rollup.
  const listings = market.listings();
  assert.equal(listings.find((l) => l.id === "credit-check")!.revenue_motes, CREDIT_CHECK_MOTES);
  assert.equal(listings.find((l) => l.id === "risk-score")!.revenue_motes, RISK_SCORE_MOTES);
});

// ---------------------------------------------------------------------------
// onReceipt hook
// ---------------------------------------------------------------------------

test("marketplace: the onReceipt hook fires once per settled call with the right amount", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();

  const collected: ReceiptCommitment[] = [];
  const runner = async (id: string, params: Record<string, unknown>) => ({ ran: id, agent_id: params.agent_id });
  const market = new CreditServiceMarketplace(econ.seller.agent_id, runner, {
    onReceipt: (r) => {
      collected.push(r);
    },
  });

  const res = await buy(market, econ.buyer, "credit-check", { agent_id: "x" });
  assert.equal(res.kind, "paid");

  assert.equal(collected.length, 1);
  assert.equal(collected[0]!.amount_motes, CREDIT_CHECK_MOTES);
  assert.equal(collected[0]!.payer_agent, econ.buyer.agent_id);
});

// ---------------------------------------------------------------------------
// Deterministic id / clock injection
// ---------------------------------------------------------------------------

test("marketplace: injected randomId + now make receipt ids and timestamps fully deterministic", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();

  let counter = 0;
  const randomId = () => `id${counter++}`;
  const now = () => 1_700_000_000;
  const runner = async (id: string, params: Record<string, unknown>) => ({ ran: id, agent_id: params.agent_id });
  const market = new CreditServiceMarketplace(econ.seller.agent_id, runner, { randomId, now });

  const res = await buy(market, econ.buyer, "credit-check", { agent_id: "x" });
  assert.equal(res.kind, "paid");
  const paid = res as Extract<MarketplaceCall, { kind: "paid" }>;

  // buildChallenge consumes id0 (payment_id) + id1 (nonce); the receipt consumes id2.
  assert.equal(paid.receipt.receipt_id, "rcpt-id2");
  assert.equal(paid.receipt.created_at, 1_700_000_000);
  assert.equal(paid.receipt.nonce, "nonce-id1");
});

test("marketplace: authenticatePayer rejects a proof that claims another agent's identity", async () => {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const runner = async (id: string) => ({ ran: id });
  // Bind payer_agent to the registered signing key (same policy as the server).
  const market = new CreditServiceMarketplace(econ.seller.agent_id, runner, {
    authenticatePayer: (payerAgent, payerPublicKey) => {
      const a = ledger.agents.get(payerAgent);
      return !a || a.agent_public_key === payerPublicKey;
    },
  });

  // Buyer signs with ITS OWN key but claims the SELLER's identity as payer_agent.
  const challenged = await market.call("credit-check", undefined, { agent_id: "x" });
  const challenge = (challenged as Extract<MarketplaceCall, { kind: "challenge" }>).body as { challenge: Parameters<typeof signPayment>[0]["challenge"] };
  const { header } = signPayment({
    challenge: challenge.challenge,
    payer_agent: econ.seller.agent_id, // spoofed identity
    payer_public_key: econ.buyer.publicKeyHex, // but buyer's real key
    payer_private_pem: econ.buyer.keys.privatePem,
  });
  const spoofed = await market.call("credit-check", header, { agent_id: "x" });
  assert.equal(spoofed.kind, "rejected");
  assert.equal((spoofed as Extract<MarketplaceCall, { kind: "rejected" }>).status, 403);

  // The buyer paying honestly under its OWN identity still succeeds.
  const honest = await buy(market, econ.buyer, "credit-check", { agent_id: "x" });
  assert.equal(honest.kind, "paid");
});
