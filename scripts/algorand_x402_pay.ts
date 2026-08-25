import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

  const reportText = await response.text();
  let report: unknown = reportText;
  try {
    report = JSON.parse(reportText) as unknown;
  } catch {
    // Settlement proof remains authoritative even if an upstream resource
    // returns non-JSON content. Preserve the exact text in the artifact.
  }
  const generatedAt = new Date().toISOString();
  const payer = settlement.payer ?? signer.address;
  const paidResourcePayment =
    report && typeof report === "object" && "payment" in report
      ? (report as { payment?: Record<string, unknown> }).payment
      : undefined;
  const evidencePayload = {
    schema_version: "cred402.algorand-x402-settlement.v1" as const,
    generated_at: generatedAt,
    request: {
      endpoint,
      request_id: response.headers.get("X-Request-Id"),
    },
    payment: {
      protocol: "x402-v2" as const,
      network: settlement.network,
      asset: inspection.selected.asset,
      amount_micro_usdc: inspection.amountMicroUsdc,
      amount_usdc: inspection.amountUsdc,
      receiver: inspection.selected.payTo,
      payer,
      transaction: settlement.transaction,
      external_receipt_id:
        typeof paidResourcePayment?.external_receipt_id === "string"
          ? paidResourcePayment.external_receipt_id
          : null,
      external_receipt_url:
        typeof paidResourcePayment?.external_receipt_url === "string"
          ? paidResourcePayment.external_receipt_url
          : null,
      casper_anchor_status:
        typeof paidResourcePayment?.casper_anchor_status === "string"
          ? paidResourcePayment.casper_anchor_status
          : "not_recorded",
    },
    resource: report,
  };
  const evidence = {
    ...evidencePayload,
    evidence_sha256: createHash("sha256")
      .update(JSON.stringify(evidencePayload))
      .digest("hex"),
  };
  const explicitOutput = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
  const timestamp = generatedAt.replaceAll(":", "-");
  const outputPath = resolve(
    explicitOutput || `artifacts/algorand-x402/settlement-${policy.networkName}-${timestamp}.json`,
  );

  console.log("\nPayment settled and resource received.");
  console.log(`Payer:       ${payer}`);
  console.log(`Transaction: ${settlement.transaction}`);
  console.log(`Network:     ${settlement.network}`);
  if (evidence.payment.external_receipt_url) {
    console.log(`Receipt:     ${evidence.payment.external_receipt_url}`);
  }
  console.log(`SHA-256:     ${evidence.evidence_sha256}`);
  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(`Evidence:    ${outputPath}`);
  } catch (error) {
    console.warn(
      `Evidence file was not written; the payment is still settled. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(`Payment flow stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
