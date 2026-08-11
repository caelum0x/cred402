/**
 * x402_market_run.ts — Cred402's x402 Credit-Service Marketplace end to end.
 *
 * Cred402 sells its credit intelligence per call over x402. A buyer agent discovers
 * the catalog, requests a service WITHOUT payment (→ 402 challenge), signs the
 * PaymentAuthorization with its ed25519 key, retries with `X-Payment: <proof>`, and
 * receives the result + a receipt. That receipt IS Cred402's own machine-to-machine
 * revenue — the exact x402 cash-flow event Cred402 turns into on-chain reputation.
 *
 *   npm run x402:market
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { CreditServiceMarketplace } from "../lib/services/x402_marketplace.js";
import { RiskEngineV2 } from "../lib/services/risk_engine_v2.js";
import { Cred402CreditOracle } from "../lib/services/credit_oracle.js";
import { signPayment } from "../lib/x402/index.js";
import { banner, scene } from "./render.js";

async function main(): Promise<void> {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.applyReputationEngine();
  econ.scoreJob();
  econ.underwriteSeller();

  const seller = econ.seller.agent_id;
  const buyer = econ.buyer;

  const runner = async (id: string, params: Record<string, unknown>): Promise<unknown> => {
    const agentId = String(params.agent_id ?? seller);
    if (id === "credit-check") return new Cred402CreditOracle(ledger).creditCheck(agentId);
    if (id === "risk-score") return new RiskEngineV2(ledger).score(agentId);
    return { note: `service ${id} executed` };
  };
  const market = new CreditServiceMarketplace(seller, runner);

  banner("Cred402 x402 Credit-Service Marketplace");

  // 1) Discover the catalog.
  scene({
    scene: "Catalog",
    lines: market.listings().map((s) => `${s.id} — ${s.name} · ${s.price_cspr} CSPR/call → ${s.resource}`),
  });

  // 2) Buy a credit-check: 402 → sign → 200.
  const params = { agent_id: seller };
  const challenged = await market.call("credit-check", undefined, params);
  if (challenged.kind !== "challenge") throw new Error("expected a 402 challenge");
  const challenge = (challenged.body as { challenge: Parameters<typeof signPayment>[0]["challenge"] }).challenge;
  scene({
    scene: "GET /x402/services/credit-check (no payment)",
    lines: [`402 Payment Required — ${Number(challenge.amount_motes) / 1e9} CSPR to ${challenge.seller_agent}`, `payment_id ${challenge.payment_id}`],
  });

  const { header } = signPayment({ challenge, payer_agent: buyer.agent_id, payer_public_key: buyer.publicKeyHex, payer_private_pem: buyer.keys.privatePem });
  const paid = await market.call("credit-check", header, params);
  if (paid.kind !== "paid") throw new Error(`expected paid, got ${paid.kind}`);
  const result = paid.result as { score?: number; limit_cspr?: number; tier?: string; exists?: boolean };
  scene({
    scene: "Retry with X-Payment → 200",
    lines: [
      `paid by ${paid.payer_agent} · receipt ${paid.receipt.receipt_id}`,
      `credit check: score ${result.score ?? "n/a"} · tier ${result.tier ?? "n/a"} · limit ${result.limit_cspr ?? "n/a"} CSPR`,
    ],
  });

  // 3) Replay protection: the same signed proof cannot be reused.
  const replay = await market.call("credit-check", header, params);
  scene({ scene: "Replay the same proof", lines: [`rejected: ${replay.kind === "rejected" ? (replay.body as { error: string }).error : "unexpectedly accepted!"}`] });

  // 4) Buy a second, different service.
  const c2 = await market.call("risk-score", undefined, params);
  const ch2 = (c2 as { body: { challenge: Parameters<typeof signPayment>[0]["challenge"] } }).body.challenge;
  const { header: h2 } = signPayment({ challenge: ch2, payer_agent: buyer.agent_id, payer_public_key: buyer.publicKeyHex, payer_private_pem: buyer.keys.privatePem });
  await market.call("risk-score", h2, params);

  scene({ scene: "Marketplace revenue", lines: [JSON.stringify(market.stats())] });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
