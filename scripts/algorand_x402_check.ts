import { readAndInspectAlgorandChallenge } from "../lib/x402/algorand_client.js";
import { loadAlgorandClientCliConfig } from "./algorand_x402_cli.js";

async function main() {
  const { endpoint, policy } = loadAlgorandClientCliConfig();
  const response = await fetch(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    redirect: "error",
  });
  const result = await readAndInspectAlgorandChallenge(response, policy);

  console.log("Algorand x402 preflight passed (no payment sent)");
  console.log(`Resource:  ${result.resourceUrl}`);
  console.log(`Network:   Algorand ${result.networkName} (${result.selected.network})`);
  console.log(`Asset:     USDC ASA ${result.selected.asset}`);
  console.log(`Amount:    ${result.amountUsdc} USDC (${result.amountMicroUsdc} micro-USDC)`);
  console.log(`Receiver:  ${result.selected.payTo}`);
  console.log("Discovery: Bazaar metadata + x402-global-challenge tag valid");
}

main().catch((error) => {
  console.error(`Preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
