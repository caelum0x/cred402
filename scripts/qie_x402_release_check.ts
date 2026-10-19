import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { QieX402PublicStatus } from "../lib/x402/qie_gateway.js";
import { readAndInspectQieChallenge } from "../lib/x402/qie_client.js";
import {
  assertQieDeploymentStatus,
  buildQieReleaseEvidence,
  qieDeploymentStatusUrl,
} from "../lib/x402/qie_release.js";
import {
  assertExternalMainnetPayer,
  assessQieAccountReadiness,
  fetchQieAccountSnapshot,
} from "../lib/x402/qie_readiness.js";
import { loadQieClientCliConfig, loadQiePayerAddress, loadQieRpcUrl } from "./qie_x402_cli.js";

/**
 * Read-only QIE release gate (`npm run x402:qie:release-check`). Mirrors
 * `scripts/algorand_x402_release_check.ts`: runs the same account-readiness
 * check as `scripts/qie_x402_ready.ts` plus the public deployment-status
 * check, then writes a signed (SHA-256 sealed) evidence artifact — see
 * `lib/x402/qie_release.ts` for exactly what "signed" means here. Never
 * signs or submits a payment transaction.
 */

async function readStatus(endpoint: string): Promise<QieX402PublicStatus> {
  const url = qieDeploymentStatusUrl(endpoint);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Deployment status returned HTTP ${response.status}`);
  const body = (await response.json()) as Partial<QieX402PublicStatus>;
  if (body.schema_version !== "cred402.qie-x402-status.v1") {
    throw new Error("Deployment status schema is missing or unsupported");
  }
  return body as QieX402PublicStatus;
}

async function main() {
  const args = process.argv.slice(2);
  const payer = loadQiePayerAddress(args, process.env);
  const { endpoint, policy } = loadQieClientCliConfig(args);
  const rpcUrl = loadQieRpcUrl(policy.networkName, process.env);

  const [status, unpaid] = await Promise.all([
    readStatus(endpoint),
    fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
    }),
  ]);
  const challenge = await readAndInspectQieChallenge(unpaid, policy);
  assertQieDeploymentStatus(status, challenge);
  assertExternalMainnetPayer(policy.networkName, payer, challenge.selected.payTo);

  const [payerSnapshot, receiverSnapshot] = await Promise.all([
    fetchQieAccountSnapshot(payer, policy.networkName, challenge.selected.asset, { rpcUrl }),
    fetchQieAccountSnapshot(challenge.selected.payTo, policy.networkName, challenge.selected.asset, { rpcUrl }),
  ]);
  const required = BigInt(challenge.amountBaseUnits);
  const payerState = assessQieAccountReadiness(payerSnapshot, "payer", required);
  const receiverState = assessQieAccountReadiness(receiverSnapshot, "receiver", required);
  const failures = [...payerState.checks, ...receiverState.checks]
    .filter((check) => check.required && !check.ok)
    .map((check) => check.message);
  if (failures.length) throw new Error(`Account gate failed: ${failures.join("; ")}`);

  const generatedAt = new Date();
  const evidence = buildQieReleaseEvidence({
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
    explicitOutput || `artifacts/qie-x402/release-check-${policy.networkName}-${timestamp}.json`,
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });

  console.log("QIE x402 release check passed (read-only; no payment or signature)");
  console.log(`Status:    ${qieDeploymentStatusUrl(endpoint)}`);
  console.log(`Resource:  ${challenge.resourceUrl}`);
  console.log(`Network:   QIE ${policy.networkName} (${challenge.selected.network})`);
  console.log(`RPC:       ${rpcUrl}`);
  console.log(`Payment:   ${challenge.amountBaseUnits} base units`);
  console.log(`Receiver:  ${challenge.selected.payTo}`);
  console.log(`Payer:     ${payer}`);
  console.log(`Block:     ${payerSnapshot.blockNumber} payer / ${receiverSnapshot.blockNumber} receiver`);
  console.log("Gates:     config, public status, challenge, account balances, network match");
  console.log(`Evidence:  ${outputPath}`);
  console.log(`SHA-256:   ${evidence.evidence_sha256}`);
}

main().catch((error) => {
  console.error(`Release check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
