import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AlgorandX402PublicStatus } from "../lib/x402/algorand_gateway.js";
import { readAndInspectAlgorandChallenge } from "../lib/x402/algorand_client.js";
import {
  algorandDeploymentStatusUrl,
  assertAlgorandDeploymentStatus,
  buildAlgorandReleaseEvidence,
} from "../lib/x402/algorand_release.js";
import {
  assessAlgorandAccountReadiness,
  assertExternalMainnetPayer,
  fetchAlgorandAccountSnapshot,
} from "../lib/x402/algorand_readiness.js";
import { loadAlgorandClientCliConfig, loadAlgorandPayerAddress } from "./algorand_x402_cli.js";

async function readStatus(endpoint: string): Promise<AlgorandX402PublicStatus> {
  const url = algorandDeploymentStatusUrl(endpoint);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Deployment status returned HTTP ${response.status}`);
  const body = await response.json() as Partial<AlgorandX402PublicStatus>;
  if (body.schema_version !== "cred402.algorand-x402-status.v1") {
    throw new Error("Deployment status schema is missing or unsupported");
  }
  return body as AlgorandX402PublicStatus;
}

async function main() {
  const args = process.argv.slice(2);
  const payer = loadAlgorandPayerAddress(args, process.env);
  const { endpoint, policy } = loadAlgorandClientCliConfig(args);

  const [status, unpaid] = await Promise.all([
    readStatus(endpoint),
    fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    }),
  ]);
  const challenge = await readAndInspectAlgorandChallenge(unpaid, policy);
  assertAlgorandDeploymentStatus(status, challenge);
  assertExternalMainnetPayer(policy.networkName, payer, challenge.selected.payTo);

  const [payerSnapshot, receiverSnapshot] = await Promise.all([
    fetchAlgorandAccountSnapshot(payer, policy.networkName, challenge.selected.asset),
    fetchAlgorandAccountSnapshot(challenge.selected.payTo, policy.networkName, challenge.selected.asset),
  ]);
  const required = BigInt(challenge.amountMicroUsdc);
  const payerState = assessAlgorandAccountReadiness(payerSnapshot, "payer", required);
  const receiverState = assessAlgorandAccountReadiness(receiverSnapshot, "receiver", required);
  const failures = [...payerState.checks, ...receiverState.checks]
    .filter((check) => check.required && !check.ok)
    .map((check) => check.message);
  if (failures.length) throw new Error(`Account gate failed: ${failures.join("; ")}`);

  const generatedAt = new Date();
  const evidence = buildAlgorandReleaseEvidence({
    generatedAt,
    endpoint,
    status,
    challenge,
    payerReadiness: payerState,
    receiverReadiness: receiverState,
    releaseRef: process.env.CRED402_RELEASE_REF ?? process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA,
  });
  const explicitOutput = args.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
  const timestamp = evidence.generated_at.replaceAll(":", "-");
  const outputPath = resolve(
    explicitOutput || `artifacts/algorand-x402/release-check-${policy.networkName}-${timestamp}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  console.log("Algorand x402 release check passed (read-only; no payment or signature)");
  console.log(`Status:    ${algorandDeploymentStatusUrl(endpoint)}`);
  console.log(`Resource:  ${challenge.resourceUrl}`);
  console.log(`Network:   Algorand ${policy.networkName} (${challenge.selected.network})`);
  console.log(`Payment:   ${challenge.amountUsdc} USDC (${challenge.amountMicroUsdc} micro-USDC)`);
  console.log(`Receiver:  ${challenge.selected.payTo}`);
  console.log(`Payer:     ${payer}`);
  console.log(`Round:     ${payerSnapshot.validAsOfRound} payer / ${receiverSnapshot.validAsOfRound} receiver`);
  console.log("Gates:     config, public status, challenge, Bazaar, account balances, USDC opt-in");
  console.log(`Evidence:  ${outputPath}`);
  console.log(`SHA-256:   ${evidence.evidence_sha256}`);
}

main().catch((error) => {
  console.error(`Release check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
