import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ExactAvmScheme, toClientAvmSigner } from "@x402/avm";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import {
  paymentConfirmationPhrase,
  readAndInspectAlgorandChallenge,
  selectSafeAlgorandAcceptance,
} from "../lib/x402/algorand_client.js";
import { loadAlgorandClientCliConfig } from "./algorand_x402_cli.js";

async function confirmPayment(expected: string): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error("Payment requires an interactive terminal; piped confirmation is refused");
  }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const entered = await terminal.question("Type the exact confirmation line shown above:\n> ");
    if (entered !== expected) throw new Error("Confirmation did not match; payment cancelled");
  } finally {
    terminal.close();
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--pay")) {
    throw new Error(
      "Refusing to sign: add --pay to enter the interactive payment flow, or use npm run x402:algorand:check",
    );
  }

  const { endpoint, policy } = loadAlgorandClientCliConfig();
  if (policy.networkName === "mainnet" && !args.includes("--mainnet")) {
    throw new Error("Mainnet payment requires the explicit --mainnet flag");
  }
  const unpaid = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const inspection = await readAndInspectAlgorandChallenge(unpaid, policy);
  const phrase = paymentConfirmationPhrase(inspection);

  console.log("\nOKX Agent Payments Protocol — payment approval required");
  console.log(`Endpoint:  ${inspection.resourceUrl}`);
  console.log(`Network:   Algorand ${inspection.networkName}`);
  console.log(`Token:     USDC ASA ${inspection.selected.asset}`);
  console.log(`Amount:    ${inspection.amountUsdc} USDC (${inspection.amountMicroUsdc} micro-USDC)`);
  console.log(`Receiver:  ${inspection.selected.payTo}`);
  console.log("Action:    Sign one exact x402 payment and retry the endpoint");
  console.log(`\n${phrase}\n`);
  await confirmPayment(phrase);

  // Deliberately read the key only after explicit interactive approval.
  const privateKey = process.env.CRED402_ALGORAND_CLIENT_PRIVATE_KEY?.trim();
  if (!privateKey) {
    throw new Error("CRED402_ALGORAND_CLIENT_PRIVATE_KEY is required after approval");
  }
  const signer = toClientAvmSigner(privateKey);
  const policyWithoutUrl = {
    networkName: policy.networkName,
    expectedPayTo: policy.expectedPayTo,
    expectedAmountMicroUsdc: policy.expectedAmountMicroUsdc,
    maxAmountMicroUsdc: policy.maxAmountMicroUsdc,
  };
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: inspection.selected.network, client: new ExactAvmScheme(signer) }],
    paymentRequirementsSelector: (version, accepts) =>
      selectSafeAlgorandAcceptance(version, accepts, policyWithoutUrl),
  });

  const response = await paidFetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Paid request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  const paymentResponse = response.headers.get("PAYMENT-RESPONSE");
  if (!paymentResponse) throw new Error("Paid response is missing the PAYMENT-RESPONSE settlement receipt");
  const settlement = decodePaymentResponseHeader(paymentResponse);
  if (!settlement.success) throw new Error(`Settlement failed: ${settlement.errorReason ?? "unknown reason"}`);

  console.log("\nPayment settled and resource received.");
  console.log(`Payer:       ${settlement.payer ?? signer.address}`);
  console.log(`Transaction: ${settlement.transaction}`);
  console.log(`Network:     ${settlement.network}`);
  console.log(JSON.stringify(await response.json(), null, 2));
}

main().catch((error) => {
  console.error(`Payment flow stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
