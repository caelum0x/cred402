import { test } from "node:test";
import assert from "node:assert/strict";
import { X402Gateway, type ReceiptCommitment } from "../lib/x402/gateway.js";
import { signPayment, type PaymentChallenge } from "../lib/x402/x402.js";
import { generateAgentKeypair } from "../lib/x402/keys.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p2 — the x402 Gateway wedge. Any API drops in this middleware and
 * becomes x402-payable + receipt-generating. Full buyer→gateway round-trip with
 * real signatures: 402 challenge → sign → verify → receipt; replay rejected;
 * analytics tracked; works for a NON-RWA service (p1).
 */

function buyerPay(challenge: PaymentChallenge) {
  const buyer = generateAgentKeypair();
  const { header } = signPayment({
    challenge,
    payer_agent: "BuyerAgent",
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.privatePem,
  });
  return header;
}

test("p2 gateway: unpaid request → 402 with a signed challenge", async () => {
  const gw = new X402Gateway({ serviceType: "inference.llm", priceMotes: cspr(0.05), sellerAgent: "caid:casper:inf-1" });
  const d = await gw.decide("/v1/infer?q=hi", undefined);
  assert.equal(d.kind, "challenge");
  if (d.kind !== "challenge") return;
  assert.equal(d.status, 402);
  assert.equal(d.headers["X-Payment-Network"], "casper");
  assert.equal(d.challenge.service_type, "inference.llm");
  assert.equal(d.challenge.amount_motes, cspr(0.05).toString());
});

test("p2 gateway: valid payment → 200 + receipt emitted to the sink", async () => {
  const receipts: ReceiptCommitment[] = [];
  const gw = new X402Gateway({
    serviceType: "data.market", priceMotes: cspr(0.02), sellerAgent: "caid:casper:data-1",
    onReceipt: (r) => { receipts.push(r); },
  });
  const c = await gw.decide("/data/feed", undefined);
  assert.equal(c.kind, "challenge");
  if (c.kind !== "challenge") return;
  const paid = await gw.decide("/data/feed", buyerPay(c.challenge));
  assert.equal(paid.kind, "paid");
  if (paid.kind !== "paid") return;
  assert.equal(paid.payer_agent, "BuyerAgent");
  assert.equal(receipts.length, 1, "receipt anchored to the sink");
  assert.equal(receipts[0]!.service_type, "data.market");
  assert.equal(receipts[0]!.amount_motes, cspr(0.02).toString());
  // analytics
  const snap = gw.analytics.snapshot();
  assert.equal(snap["/data/feed"]!.paid, 1);
  assert.equal(snap["/data/feed"]!.revenue_motes, cspr(0.02).toString());
});

test("p2 gateway: replayed proof is rejected (one-time nonce + proof)", async () => {
  const gw = new X402Gateway({ serviceType: "api.generic", priceMotes: cspr(0.01), sellerAgent: "caid:casper:api-1" });
  const c = await gw.decide("/x", undefined);
  if (c.kind !== "challenge") throw new Error("expected challenge");
  const header = buyerPay(c.challenge);
  const first = await gw.decide("/x", header);
  assert.equal(first.kind, "paid");
  const replay = await gw.decide("/x", header);
  assert.equal(replay.kind, "rejected");
  if (replay.kind === "rejected") assert.match(replay.body.error, /replay|expired|unknown/i);
});

test("p2 gateway: tampered amount fails verification", async () => {
  const gw = new X402Gateway({ serviceType: "compute.gpu", priceMotes: cspr(1), sellerAgent: "caid:casper:gpu-1" });
  const c = await gw.decide("/gpu", undefined);
  if (c.kind !== "challenge") throw new Error("expected challenge");
  // buyer signs a DIFFERENT (cheaper) amount than the challenge
  const buyer = generateAgentKeypair();
  const forged = signPayment({
    challenge: { ...c.challenge, amount_motes: cspr(0.001).toString() },
    payer_agent: "Cheapskate",
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.privatePem,
  }).header;
  const d = await gw.decide("/gpu", forged);
  assert.equal(d.kind, "rejected");
});

test("p2 gateway: Web (Fetch) adapter gates a handler end-to-end", async () => {
  const gw = new X402Gateway({ serviceType: "inference.embedding", priceMotes: cspr(0.03), sellerAgent: "caid:casper:emb-1", randomId: (() => { let n = 0; return () => `id${n++}`; })() });
  const protectedHandler = gw.web(() => new Response(JSON.stringify({ embedding: [0.1, 0.2] }), { status: 200 }));

  const unpaid = await protectedHandler(new Request("https://api.x/embed?text=hi"));
  assert.equal(unpaid.status, 402);
  const challenge = ((await unpaid.json()) as { challenge: PaymentChallenge }).challenge;

  const req = new Request("https://api.x/embed?text=hi", { headers: { "X-Payment": buyerPay(challenge) } });
  const paid = await protectedHandler(req);
  assert.equal(paid.status, 200);
  assert.deepEqual(((await paid.json()) as { embedding: number[] }).embedding, [0.1, 0.2]);
});
