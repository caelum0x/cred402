import { readAndInspectQieChallenge, type QiePaymentPolicy } from "../lib/x402/qie_client.js";
import { qieNetworkNameFor } from "../lib/x402/qie_networks.js";

/**
 * Read-only QIE x402 preflight check (`npm run x402:qie:check`). Mirrors
 * `scripts/algorand_x402_check.ts`: fetches the unpaid challenge, decodes
 * `PAYMENT-REQUIRED`, and enforces the exact `exact`-scheme requirements
 * before any client would sign or submit a transaction. Never pays.
 */

function loadCliConfig(): { endpoint: string; policy: QiePaymentPolicy } {
  const endpoint = process.argv[process.argv.length - 1];
  if (!endpoint || endpoint.startsWith("--") || !endpoint.includes("://")) {
    throw new Error("Usage: npm run x402:qie:check -- https://host/v1/x402/qie/credit-score/AGENT_ID");
  }
  const networkName = qieNetworkNameFor((process.env.CRED402_QIE_CLIENT_NETWORK ?? "testnet").trim());
  if (!networkName) throw new Error("CRED402_QIE_CLIENT_NETWORK must be testnet or mainnet");

  const expectedPayTo = process.env.CRED402_QIE_EXPECTED_PAY_TO?.trim();
  if (!expectedPayTo) throw new Error("CRED402_QIE_EXPECTED_PAY_TO is required");

  const expectedAssetAddress = process.env.CRED402_QIE_EXPECTED_ASSET_ADDRESS?.trim();
  if (!expectedAssetAddress) throw new Error("CRED402_QIE_EXPECTED_ASSET_ADDRESS is required");

  const maxAmountBaseUnits = process.env.CRED402_QIE_MAX_PRICE_BASE_UNITS?.trim() ?? "10000";
  const expectedAmountBaseUnits = process.env.CRED402_QIE_EXPECTED_PRICE_BASE_UNITS?.trim();

  return {
    endpoint,
    policy: { networkName, expectedPayTo, expectedAssetAddress, expectedAmountBaseUnits, maxAmountBaseUnits, requestUrl: endpoint },
  };
}

async function main() {
  const { endpoint, policy } = loadCliConfig();
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const result = await readAndInspectQieChallenge(response, policy);

  console.log("QIE x402 preflight passed (no payment sent)");
  console.log(`Resource:  ${result.resourceUrl}`);
  console.log(`Network:   QIE ${result.networkName} (${result.selected.network})`);
  console.log(`Asset:     ${result.selected.asset}`);
  console.log(`Amount:    ${result.amountBaseUnits} base units`);
  console.log(`Receiver:  ${result.selected.payTo}`);
}

main().catch((error) => {
  console.error(`Preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
