/**
 * Reference: turn ANY API into an x402-payable, receipt-generating endpoint with
 * the Cred402 gateway (roadmap p2). Express shown; a Web/Fetch (Next.js/edge)
 * adapter is also available via `gateway.web(handler)`.
 *
 * This is the adoption wedge: every wrapped route builds the seller agent's
 * on-chain credit history — Cred402 works for any x402 service, not just RWA.
 */
import { X402Gateway } from "../lib/x402/gateway.js";
import { cspr } from "../lib/core/units.js";

// 1. Configure the gateway for your service + price + receiving agent.
const gateway = new X402Gateway({
  serviceType: "inference.llm", // any p1 category: data.*, compute.*, api.*, rwa.*, …
  priceMotes: cspr(0.05),
  sellerAgent: "caid:casper:my-inference-agent",
  // Anchor each receipt to Cred402 (POST to /v1/x402/receipts, write to Casper, …):
  onReceipt: async (receipt) => {
    // await fetch("https://cred402-1.onrender.com/v1/x402/receipts", {
    //   method: "POST", headers: { "content-type": "application/json" },
    //   body: JSON.stringify(receipt) });
    console.log("anchor receipt", receipt.receipt_id, receipt.amount_motes);
  },
});

// 2. Drop it in front of any route. Unpaid → 402; paid → your handler runs.
//
//   import express from "express";
//   const app = express();
//   app.get("/v1/infer", gateway.express(), (req, res) => {
//     // req.cred402.receipt + req.cred402.payer are available here
//     res.json({ answer: runInference(req.query.q) });
//   });
//   app.listen(8080);
//
// Next.js / edge (Web Fetch):
//
//   export const GET = gateway.web((req, { receipt, payer }) =>
//     Response.json({ answer: runInference(new URL(req.url).searchParams.get("q")) }));

export { gateway };
