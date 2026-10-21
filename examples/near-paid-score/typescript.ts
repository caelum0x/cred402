/**
 * Pay for a Cred402 credit score with native NEAR on NEAR Testnet, then
 * verify the resulting Casper-rooted receipt.
 *
 * Mirrors `examples/algorand-paid-score/typescript.ts`: fetch and display the
 * unpaid x402 v2 `402 Payment Required` challenge, ask for an exact
 * interactive approval, sign and submit the NEAR transfer, retry the
 * request with the resulting `PAYMENT-SIGNATURE` header, validate
 * `PAYMENT-RESPONSE`, and confirm the same finalized receipt through both
 * its public proof URL and the NEAR usage feed.
 *
 * Unlike the Algorand/QIE examples, there is no `@x402/near` client package
 * to wrap `fetch` with — NEAR has no x402 scheme package yet. This talks to
 * the server's hand-rolled `exact` scheme directly: it signs a native NEAR
 * `Transfer` action with `near-api-js` against NEAR Testnet (free, no faucet
 * card required — see https://near-faucet.io), submits it, and presents the
 * resulting transaction hash as payment proof. Cred402 is its own
 * facilitator: it re-reads that transaction from its own configured NEAR
 * RPC before settling (see `docs/near_x402.md`).
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Account, JsonRpcProvider, KeyPairSigner, actions } from "near-api-js";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

const TESTNET = "near:testnet";
const MAINNET = "near:mainnet";
const networkName = process.env.CRED402_NEAR_CLIENT_NETWORK === "mainnet" ? "mainnet" : "testnet";
const expectedNetwork = networkName === "mainnet" ? MAINNET : TESTNET;
const rpcUrl = process.env.CRED402_NEAR_CLIENT_RPC_URL ??
  (networkName === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");
const endpoint = process.env.CRED402_NEAR_CLIENT_URL ??
  "https://cred402-1.onrender.com/v1/x402/near/credit-score/EvidenceSellerAgent";
const expectedPayTo = process.env.CRED402_NEAR_EXPECTED_PAY_TO?.trim() ?? "";
const expectedAmount = process.env.CRED402_NEAR_EXPECTED_PRICE_YOCTO ?? "10000000000000000000000";
const maxAmount = process.env.CRED402_NEAR_MAX_PRICE_YOCTO ?? expectedAmount;

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function selectSafeRequirement(version: number, accepts: PaymentRequirements[]): PaymentRequirements {
  invariant(version === 2, `Expected x402 v2; received v${version}`);
  invariant(accepts.length === 1, `Expected one payment option; received ${accepts.length}`);
  const selected = accepts[0]!;
  invariant(selected.scheme === "exact", `Unexpected scheme: ${selected.scheme}`);
  invariant(selected.network === expectedNetwork, `Unexpected network: ${selected.network}`);
  invariant(selected.asset === "near-native", `Unexpected asset: ${selected.asset}`);
  invariant(selected.payTo === expectedPayTo, `Unexpected receiver: ${selected.payTo}`);
  invariant(/^\d+$/.test(selected.amount), "Payment amount is not an unsigned integer");
  invariant(BigInt(selected.amount) === BigInt(expectedAmount), `Unexpected amount: ${selected.amount}`);
  invariant(BigInt(selected.amount) <= BigInt(maxAmount), `Amount exceeds ceiling: ${selected.amount}`);
  invariant(
    Number.isSafeInteger(selected.maxTimeoutSeconds) && selected.maxTimeoutSeconds > 0 && selected.maxTimeoutSeconds <= 300,
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
  const body = (await response.json()) as Record<string, any>;
  invariant(response.ok, `${url} returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  invariant(expectedPayTo, "Set CRED402_NEAR_EXPECTED_PAY_TO to the trusted receiver account id");
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
  console.log("payment-required", JSON.stringify(challenge, null, 2));

  const phrase = `PAY ${selected.amount} YOCTONEAR ON NEAR ${networkName.toUpperCase()} TO ${selected.payTo}`;
  await approve(phrase);

  // 2. Only after approval, read the key, sign a native NEAR Transfer action,
  //    and submit it directly to the configured NEAR RPC.
  const signerAccountId = process.env.CRED402_NEAR_CLIENT_ACCOUNT_ID?.trim();
  const privateKey = process.env.CRED402_NEAR_CLIENT_PRIVATE_KEY?.trim();
  invariant(signerAccountId, "Set CRED402_NEAR_CLIENT_ACCOUNT_ID after approving the payment");
  invariant(privateKey, "Set CRED402_NEAR_CLIENT_PRIVATE_KEY (ed25519:... secret key) after approving the payment");

  const provider = new JsonRpcProvider({ url: rpcUrl });
  const signer = KeyPairSigner.fromSecretKey(privateKey as `ed25519:${string}`);
  const account = new Account(signerAccountId, provider, signer);

  const outcome = await account.signAndSendTransaction({
    receiverId: selected.payTo,
    actions: [actions.transfer(BigInt(selected.amount))],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: true,
  });
  const transactionHash = outcome.transaction.hash;
  invariant(transactionHash, "NEAR did not return a transaction hash");
  console.log("near-transaction", transactionHash);

  // 3. Retry the request with the resulting PAYMENT-SIGNATURE header.
  const paymentSignature = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: selected,
    payload: { signerId: signerAccountId, transaction: transactionHash },
  });
  const paid = await fetch(requested, {
    headers: { accept: "application/json", "PAYMENT-SIGNATURE": paymentSignature },
    redirect: "error",
  });
  const report = (await paid.json()) as Record<string, any>;
  invariant(paid.ok, `Paid retry returned HTTP ${paid.status}: ${JSON.stringify(report)}`);

  // 4. Validate the settlement header against the paid resource body.
  const encodedSettlement = paid.headers.get("PAYMENT-RESPONSE");
  invariant(encodedSettlement, "Paid response is missing PAYMENT-RESPONSE");
  const settlement = decodePaymentResponseHeader(encodedSettlement);
  invariant(settlement.success, `Settlement failed: ${settlement.errorReason ?? "unknown reason"}`);
  invariant(report.payment?.transaction === settlement.transaction, "Report and settlement transactions differ");
  invariant(report.payment?.network === settlement.network, "Report and settlement networks differ");
  invariant(report.payment?.external_receipt_id, "Paid report is missing external_receipt_id");
  invariant(report.payment?.external_receipt_url, "Paid report is missing external_receipt_url");

  // 5. Validate the content-addressed receipt and find the same id in usage.
  const proof = await getJson(report.payment.external_receipt_url);
  invariant(proof.receipt_id === report.payment.external_receipt_id, "Receipt proof id differs from report");
  invariant(proof.integrity?.ok === true, "Receipt proof integrity check failed");
  invariant(proof.settlement?.transaction === settlement.transaction, "Receipt proof transaction differs");

  const usageUrl = new URL("/v1/x402/near/usage", requested.origin).href;
  const usage = await getJson(usageUrl);
  const usageReceipt = usage.latest_receipts?.find(
    (receipt: Record<string, unknown>) => receipt.receipt_id === proof.receipt_id,
  );

  console.log("payment-proof", JSON.stringify(settlement, null, 2));
  console.log("paid-score", JSON.stringify(report, null, 2));
  console.log("receipt-verified", JSON.stringify({ proof, usage_receipt: usageReceipt ?? null }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
