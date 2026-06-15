/**
 * x402_client.ts — a standalone autonomous buyer that pays a live Cred402 paid
 * endpoint over real HTTP. Demonstrates the full 402 -> sign -> retry -> report
 * flow against the running server.
 *
 *   pnpm start                                   # terminal 1
 *   tsx scripts/x402_client.ts energy_output     # terminal 2
 */
import { generateAgentKeypair, signPayment, type PaymentChallenge } from "../lib/x402/index.js";

const PORT = process.env.CRED402_PORT ?? "4021";
const evidence_type = process.argv[2] ?? "energy_output";
const rwa_id = "SOLAR-A17";
const url = `http://localhost:${PORT}/verify/${evidence_type}?rwa_id=${rwa_id}&buyer=external.buyer`;

async function main(): Promise<void> {
  const keys = generateAgentKeypair();
  console.log(`buyer identity (Casper pubkey): ${keys.publicKeyHex.slice(0, 18)}…\n`);

  // 1. Unpaid request -> expect 402.
  const first = await fetch(url);
  console.log(`GET ${evidence_type} -> ${first.status} ${first.statusText}`);
  console.log(`  X-Payment-Amount: ${first.headers.get("x-payment-amount")} CSPR`);
  console.log(`  X-Payment-Network: ${first.headers.get("x-payment-network")}`);
  if (first.status !== 402) throw new Error(`expected 402, got ${first.status}`);
  const { challenge } = (await first.json()) as { challenge: PaymentChallenge };

  // 2. Sign the domain-separated payment authorization.
  const { header } = signPayment({
    challenge,
    payer_agent: "external.buyer",
    payer_public_key: keys.publicKeyHex,
    payer_private_pem: keys.privatePem,
  });
  console.log(`\n  signed payment proof, retrying with X-Payment header…\n`);

  // 3. Paid request -> expect 200 + report.
  const paid = await fetch(url, { headers: { "X-Payment": header } });
  console.log(`GET ${evidence_type} (paid) -> ${paid.status} ${paid.statusText}`);
  const body = (await paid.json()) as Record<string, unknown>;
  console.log(JSON.stringify(body, null, 2));
}

main().catch((err) => {
  console.error(`x402 client error: ${err.message}`);
  console.error(`Is the server running?  Start it with \`pnpm start\`.`);
  process.exit(1);
});
