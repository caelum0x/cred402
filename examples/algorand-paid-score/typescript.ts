import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ExactAvmScheme, toClientAvmSigner } from "@x402/avm";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";

const TESTNET = "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=";
const MAINNET = "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=";
const USDC = { testnet: 10_458_941, mainnet: 31_566_704 } as const;
const networkName = process.env.CRED402_ALGORAND_CLIENT_NETWORK === "mainnet"
  ? "mainnet"
  : "testnet";
const expectedNetwork = networkName === "mainnet" ? MAINNET : TESTNET;
const expectedAsset = USDC[networkName];
const endpoint = process.env.CRED402_ALGORAND_CLIENT_URL ??
  "https://cred402-1.onrender.com/v1/x402/credit-score/EvidenceSellerAgent";
const expectedPayTo = process.env.CRED402_ALGORAND_EXPECTED_PAY_TO?.trim() ?? "";
const expectedAmount = process.env.CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC ?? "10000";
const maxAmount = process.env.CRED402_ALGORAND_MAX_PRICE_MICRO_USDC ?? expectedAmount;

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function selectSafeRequirement(
  version: number,
  accepts: PaymentRequirements[],
): PaymentRequirements {
  invariant(version === 2, `Expected x402 v2; received v${version}`);
  invariant(accepts.length === 1, `Expected one payment option; received ${accepts.length}`);
  const selected = accepts[0]!;
  invariant(selected.scheme === "exact", `Unexpected scheme: ${selected.scheme}`);
  invariant(selected.network === expectedNetwork, `Unexpected network: ${selected.network}`);
  invariant(selected.asset === expectedAsset, `Unexpected USDC ASA: ${selected.asset}`);
  invariant(selected.payTo === expectedPayTo, `Unexpected receiver: ${selected.payTo}`);
  invariant(/^\d+$/.test(selected.amount), "Payment amount is not an unsigned integer");
  invariant(BigInt(selected.amount) === BigInt(expectedAmount), `Unexpected amount: ${selected.amount}`);
  invariant(BigInt(selected.amount) <= BigInt(maxAmount), `Amount exceeds ceiling: ${selected.amount}`);
  invariant(
    Number.isSafeInteger(selected.maxTimeoutSeconds) &&
      selected.maxTimeoutSeconds > 0 &&
      selected.maxTimeoutSeconds <= 300,
    `Unsafe timeout: ${selected.maxTimeoutSeconds}`,
  );
  return selected;
}

async function approve(phrase: string): Promise<void> {
  invariant(stdin.isTTY && stdout.isTTY, "Payment approval requires an interactive terminal");
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const entered = await terminal.question(`Type this exact line to approve:\n${phrase}\n> `);
    invariant(entered === phrase, "Approval did not match; payment cancelled");
  } finally {
    terminal.close();
  }
}

async function getJson(url: string): Promise<Record<string, any>> {
  const response = await fetch(url, { headers: { accept: "application/json" }, redirect: "error" });
  const body = await response.json() as Record<string, any>;
  invariant(response.ok, `${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  invariant(expectedPayTo, "Set CRED402_ALGORAND_EXPECTED_PAY_TO to the trusted receiver");
  const requested = new URL(endpoint);
  invariant(requested.protocol === "https:" || networkName === "testnet", "Mainnet requires HTTPS");
  invariant(
    networkName !== "mainnet" || process.env.CRED402_ALLOW_MAINNET === "true",
    "Mainnet requires CRED402_ALLOW_MAINNET=true",
  );

  // 1. Fetch and display the unpaid payment-required response. No key is read.
  const unpaid = await fetch(requested, { headers: { accept: "application/json" }, redirect: "error" });
  invariant(unpaid.status === 402, `Expected HTTP 402; received ${unpaid.status}`);
  const encodedChallenge = unpaid.headers.get("PAYMENT-REQUIRED");
  invariant(encodedChallenge, "402 response is missing PAYMENT-REQUIRED");
  const challenge = decodePaymentRequiredHeader(encodedChallenge);
  const selected = selectSafeRequirement(challenge.x402Version, challenge.accepts);
  invariant(challenge.resource?.url, "Challenge resource URL is missing");
  invariant(new URL(challenge.resource.url).href === requested.href, "Challenge resource URL changed");
  invariant(challenge.resource.tags?.includes("x402-global-challenge"), "Challenge tag is missing");
  // The facilitator attributes settled volume from the accepted option's extra.tag.
  invariant(
    (selected.extra as Record<string, unknown> | null | undefined)?.tag === "x402-global-challenge",
    "Accepted payment option is missing extra.tag=x402-global-challenge",
  );
  console.log("payment-required", JSON.stringify(challenge, null, 2));

  const phrase = `PAY ${selected.amount} MICRO-USDC ON ALGORAND ${networkName.toUpperCase()} TO ${selected.payTo}`;
  await approve(phrase);

  // 2. Only after approval, read the key and let the official client perform
  //    its own 402 -> PAYMENT-SIGNATURE -> retry cycle under the same policy.
  const privateKey = process.env.CRED402_ALGORAND_CLIENT_PRIVATE_KEY?.trim();
  invariant(privateKey, "Set CRED402_ALGORAND_CLIENT_PRIVATE_KEY after approving the payment");
  const signer = toClientAvmSigner(privateKey);
  const paidFetch = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: expectedNetwork, client: new ExactAvmScheme(signer) }],
    paymentRequirementsSelector: selectSafeRequirement,
  });
  const paid = await paidFetch(requested, { headers: { accept: "application/json" }, redirect: "error" });
  const report = await paid.json() as Record<string, any>;
  invariant(paid.ok, `Paid retry returned HTTP ${paid.status}: ${JSON.stringify(report)}`);

  // 3. Validate the official settlement header against the paid resource body.
  const encodedSettlement = paid.headers.get("PAYMENT-RESPONSE");
  invariant(encodedSettlement, "Paid response is missing PAYMENT-RESPONSE");
  const settlement = decodePaymentResponseHeader(encodedSettlement);
  invariant(settlement.success, `Settlement failed: ${settlement.errorReason ?? "unknown reason"}`);
  invariant(report.payment?.transaction === settlement.transaction, "Report and settlement transactions differ");
  invariant(report.payment?.network === settlement.network, "Report and settlement networks differ");
  invariant(report.payment?.external_receipt_id, "Paid report is missing external_receipt_id");
  invariant(report.payment?.external_receipt_url, "Paid report is missing external_receipt_url");
  invariant(report.payment?.casper_anchor_status === "finalized", "Cred402 receipt is not finalized");

  // 4. Validate the content-addressed receipt and find the same id in usage.
  const proof = await getJson(report.payment.external_receipt_url);
  invariant(proof.receipt_id === report.payment.external_receipt_id, "Receipt proof id differs from report");
  invariant(proof.integrity?.ok === true, "Receipt proof integrity check failed");
  invariant(proof.anchor?.status === "finalized", "Receipt proof is not finalized");
  invariant(proof.settlement?.transaction === settlement.transaction, "Receipt proof transaction differs");

  const usageUrl = new URL("/v1/x402/algorand/usage", requested.origin).href;
  const usage = await getJson(usageUrl);
  const usageReceipt = usage.latest_receipts?.find(
    (receipt: Record<string, unknown>) => receipt.receipt_id === proof.receipt_id,
  );
  invariant(usageReceipt, `Receipt ${proof.receipt_id} was not found in ${usageUrl}`);

  console.log("payment-proof", JSON.stringify(settlement, null, 2));
  console.log("paid-score", JSON.stringify(report, null, 2));
  console.log("receipt-verified", JSON.stringify({ proof, usage_receipt: usageReceipt }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
