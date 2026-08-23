import { formatMicroUsdc, readAndInspectAlgorandChallenge } from "../lib/x402/algorand_client.js";
import {
  assessAlgorandAccountReadiness,
  assertExternalMainnetPayer,
  fetchAlgorandAccountSnapshot,
  formatMicroAlgo,
  type AlgorandAccountReadiness,
} from "../lib/x402/algorand_readiness.js";
import { loadAlgorandClientCliConfig, loadAlgorandPayerAddress } from "./algorand_x402_cli.js";

function printAccount(result: AlgorandAccountReadiness) {
  const title = result.role === "payer" ? "Payer" : "Receiver";
  console.log(`\n${result.ready ? "READY" : "NOT READY"} — ${title} ${result.snapshot.address}`);
  console.log(`Round: ${result.snapshot.validAsOfRound}`);
  for (const check of result.checks) {
    const state = check.ok ? "PASS" : check.required ? "FAIL" : "WARN";
    console.log(`[${state}] ${check.message}`);
  }
  console.log(
    `Balances: ${formatMicroAlgo(result.snapshot.balanceMicroAlgo)} ALGO, ${
      formatMicroUsdc(result.snapshot.usdcBalanceMicro.toString())
    } USDC`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  const payer = loadAlgorandPayerAddress(args, process.env);
  const { endpoint, policy } = loadAlgorandClientCliConfig(args);

  const response = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const challenge = await readAndInspectAlgorandChallenge(response, policy);
  assertExternalMainnetPayer(policy.networkName, payer, challenge.selected.payTo);
  const [payerSnapshot, receiverSnapshot] = await Promise.all([
    fetchAlgorandAccountSnapshot(payer, policy.networkName, challenge.selected.asset),
    fetchAlgorandAccountSnapshot(
      challenge.selected.payTo,
      policy.networkName,
      challenge.selected.asset,
    ),
  ]);
  const required = BigInt(challenge.amountMicroUsdc);
  const payerReadiness = assessAlgorandAccountReadiness(payerSnapshot, "payer", required);
  const receiverReadiness = assessAlgorandAccountReadiness(receiverSnapshot, "receiver", required);

  console.log("Algorand x402 account readiness (read-only; no payment or signature)");
  console.log(`Network: Algorand ${policy.networkName}; USDC ASA ${challenge.selected.asset}`);
  console.log(`Payment under test: ${challenge.amountUsdc} USDC`);
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
