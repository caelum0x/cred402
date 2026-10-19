import { readAndInspectQieChallenge } from "../lib/x402/qie_client.js";
import {
  assertExternalMainnetPayer,
  assessQieAccountReadiness,
  fetchQieAccountSnapshot,
  formatBaseUnits,
  type QieAccountReadiness,
} from "../lib/x402/qie_readiness.js";
import { loadQieClientCliConfig, loadQiePayerAddress, loadQieRpcUrl } from "./qie_x402_cli.js";

/**
 * Read-only QIE account readiness (`npm run x402:qie:ready`). Mirrors
 * `scripts/algorand_x402_ready.ts`: fetches the unpaid challenge, then fetches
 * live payer/receiver balances over the configured QIE RPC and reports
 * whether each account is ready to pay or receive. Never signs or submits a
 * transaction. Fails closed (clear error, no guessed RPC/contract address)
 * if the required configuration is missing — see `loadQieRpcUrl` and
 * `loadQieClientCliConfig` in `scripts/qie_x402_cli.ts`.
 */

function printAccount(result: QieAccountReadiness) {
  const title = result.role === "payer" ? "Payer" : "Receiver";
  console.log(`\n${result.ready ? "READY" : "NOT READY"} — ${title} ${result.snapshot.address}`);
  console.log(`Block: ${result.snapshot.blockNumber}`);
  for (const check of result.checks) {
    const state = check.ok ? "PASS" : check.required ? "FAIL" : "WARN";
    console.log(`[${state}] ${check.message}`);
  }
  console.log(`Balance: ${formatBaseUnits(result.snapshot.tokenBalanceBaseUnits, 6)} tokens (base units: ${result.snapshot.tokenBalanceBaseUnits})`);
}

async function main() {
  const args = process.argv.slice(2);
  const payer = loadQiePayerAddress(args, process.env);
  const { endpoint, policy } = loadQieClientCliConfig(args);
  const rpcUrl = loadQieRpcUrl(policy.networkName, process.env);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const challenge = await readAndInspectQieChallenge(response, policy);
  assertExternalMainnetPayer(policy.networkName, payer, challenge.selected.payTo);

  const [payerSnapshot, receiverSnapshot] = await Promise.all([
    fetchQieAccountSnapshot(payer, policy.networkName, challenge.selected.asset, { rpcUrl }),
    fetchQieAccountSnapshot(challenge.selected.payTo, policy.networkName, challenge.selected.asset, { rpcUrl }),
  ]);
  const required = BigInt(challenge.amountBaseUnits);
  const payerReadiness = assessQieAccountReadiness(payerSnapshot, "payer", required);
  const receiverReadiness = assessQieAccountReadiness(receiverSnapshot, "receiver", required);

  console.log("QIE x402 account readiness (read-only; no payment or signature)");
  console.log(`Network: QIE ${policy.networkName}; asset ${challenge.selected.asset}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`Payment under test: ${challenge.amountBaseUnits} base units`);
  printAccount(payerReadiness);
  printAccount(receiverReadiness);

  if (!payerReadiness.ready || !receiverReadiness.ready) {
    throw new Error("Account readiness checks failed; do not start the payment flow yet");
  }
  console.log("\nREADY — required account checks passed. No transaction was sent.");
}

main().catch((error) => {
  console.error(`Readiness failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
