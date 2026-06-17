/**
 * gateway_demo.ts (roadmap p2) — the x402 Gateway wedge. Wrap ANY API route with
 * one middleware and it becomes x402-payable + receipt-generating. Here a "paid
 * inference API" earns x402 revenue; the receipt feeds the Cred402 credit moat.
 *
 *   npm run demo:gateway
 */
import { X402Gateway } from "../lib/x402/gateway.js";
import { signPayment } from "../lib/x402/x402.js";
import { generateAgentKeypair } from "../lib/x402/keys.js";
import { cspr, formatCspr } from "../lib/core/units.js";

// 1. A data provider wraps its endpoint — the one-liner.
const anchored: string[] = [];
const gw = new X402Gateway({
  serviceType: "inference.llm",
  priceMotes: cspr(0.05),
  sellerAgent: "caid:casper:inference-api-01",
  onReceipt: (r) => { anchored.push(r.receipt_id); }, // anchor to Cred402 (ledger/API/Casper)
});

console.log("\n● A paid inference API, wrapped with the Cred402 x402 gateway (one middleware)");
console.log("  GET /v1/infer  price 0.05 CSPR  service inference.llm\n");

async function main() {
  // 2. An agent calls it unpaid -> 402 challenge.
  const challenged = await gw.decide("/v1/infer?q=summarize", undefined);
  if (challenged.kind !== "challenge") throw new Error("expected 402");
  console.log(`  → 402 Payment Required (payment_id ${challenged.challenge.payment_id})`);

  // 3. The agent signs the challenge and retries.
  const buyer = generateAgentKeypair();
  const { header } = signPayment({
    challenge: challenged.challenge,
    payer_agent: "caid:casper:research-agent-09",
    payer_public_key: buyer.publicKeyHex,
    payer_private_pem: buyer.privatePem,
  });
  const paid = await gw.decide("/v1/infer?q=summarize", header);
  if (paid.kind !== "paid") throw new Error("payment should verify");
  console.log(`  → 200 OK — payment verified, request proceeds`);
  console.log(`    receipt ${paid.receipt.receipt_id}: ${paid.payer_agent} paid ${formatCspr(BigInt(paid.receipt.amount_motes))} CSPR`);
  console.log(`    anchored to Cred402 (feeds the seller's credit history): ${anchored.length} receipt(s)`);

  // 4. Replay is rejected.
  const replay = await gw.decide("/v1/infer?q=summarize", header);
  console.log(`  → replay of the same proof: ${replay.kind === "rejected" ? "rejected ✓" : "ACCEPTED ✗"}`);

  // 5. The seller's analytics.
  const snap = gw.analytics.snapshot()["/v1/infer?q=summarize"]!;
  console.log(`\n● Seller analytics  /v1/infer: ${snap.paid} paid · ${snap.challenged} challenged · ${snap.rejected} rejected · revenue ${formatCspr(BigInt(snap.revenue_motes))} CSPR`);
  console.log("\nEvery wrapped API feeds agent credit history. That's the wedge.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
