/**
 * deploy_testnet.ts — deploy the core Odra contracts to Casper Testnet (p8).
 *
 * Two modes, selected by environment:
 *
 *   DRY RUN (default): prints the exact `casper-client put-deploy` plan and writes
 *     a manifest so the dashboard shows contract slots. No network, no keys.
 *
 *   LIVE: set CRED402_NODE + CRED402_SECRET_KEY (and build the WASM first) to
 *     install each contract for real via casper-js-sdk (`ModuleBytes` deploy),
 *     wait for execution, resolve the on-chain contract hash, and write real
 *     deploy + contract hashes to deploys.testnet.json.
 *
 * Build WASM first:  cd contracts && cargo build --release --target wasm32-unknown-unknown
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployHash } from "../lib/core/hash.js";
import { readCasperEnv, isLiveConfigured } from "../lib/casper/factory.js";

interface ContractSpec {
  crate: string;
  name: string;
  wasm: string;
  /** payment in whole CSPR (×1e9 motes). */
  paymentCspr: number;
  /** named-key hints used to resolve the installed contract hash. */
  namedKeyHints: string[];
}

const CONTRACTS: ContractSpec[] = [
  { crate: "agent_registry", name: "AgentRegistry", wasm: "agent_registry.wasm", paymentCspr: 120, namedKeyHints: ["agent_registry_package_hash", "agent_registry_contract_hash", "agent_registry"] },
  { crate: "x402_receipt_registry", name: "X402ReceiptRegistry", wasm: "x402_receipt_registry.wasm", paymentCspr: 120, namedKeyHints: ["x402_receipt_registry_package_hash", "x402_receipt_registry"] },
  { crate: "rwa_evidence_registry", name: "RWAEvidenceRegistry", wasm: "rwa_evidence_registry.wasm", paymentCspr: 120, namedKeyHints: ["rwa_evidence_registry_package_hash", "rwa_evidence_registry"] },
  { crate: "agent_credit_pool", name: "AgentCreditPool", wasm: "agent_credit_pool.wasm", paymentCspr: 150, namedKeyHints: ["agent_credit_pool_package_hash", "agent_credit_pool"] },
  { crate: "risk_policy_manager", name: "RiskPolicyManager", wasm: "risk_policy_manager.wasm", paymentCspr: 100, namedKeyHints: ["risk_policy_manager_package_hash", "risk_policy_manager"] },
];

function wasmPath(crate: string, wasm: string): string {
  return resolve(process.cwd(), `contracts/${crate}/target/wasm32-unknown-unknown/release/${wasm}`);
}

interface ManifestEntry {
  name: string;
  crate: string;
  contract_hash: string;
  deploy_hash: string;
  status: "planned" | "installed" | "failed";
  error?: string;
}

async function runDryRun(): Promise<ManifestEntry[]> {
  const node = process.env.CRED402_NODE ?? "https://node.testnet.casper.network/rpc";
  return CONTRACTS.map((c) => {
    const hash = deployHash();
    console.log(`  plan ${c.name}`);
    console.log(`    casper-client put-deploy \\`);
    console.log(`      --node-address ${node} \\`);
    console.log(`      --chain-name casper-test \\`);
    console.log(`      --secret-key $CRED402_SECRET_KEY \\`);
    console.log(`      --payment-amount ${c.paymentCspr}000000000 \\`);
    console.log(`      --session-path contracts/${c.crate}/target/wasm32-unknown-unknown/release/${c.wasm}`);
    console.log(`    -> deploy_hash ${hash}\n`);
    return { name: c.name, crate: c.crate, contract_hash: `hash-${hash.slice(0, 40)}`, deploy_hash: hash, status: "planned" as const };
  });
}

async function runLive(): Promise<ManifestEntry[]> {
  const env = readCasperEnv();
  const { installContract, resolveContractHash } = await import("../lib/casper/install.js");
  const { CasperRpcClient } = await import("../lib/casper/rpc.js");
  const { CasperRpcTransport } = await import("../lib/casper/transport.js");
  const { CasperSdkDeploySigner } = await import("../lib/casper/sdk_signer.js");

  const secretKeyPem = readFileSync(env.secretKeyPath as string, "utf8");
  const rpc = new CasperRpcClient({ nodeAddress: env.nodeAddress as string });
  const signer = new CasperSdkDeploySigner({ secretKeyPem, algorithm: env.algorithm, nodeAddress: env.nodeAddress as string });
  const transport = new CasperRpcTransport(rpc, signer);

  const results: ManifestEntry[] = [];
  for (const c of CONTRACTS) {
    const path = wasmPath(c.crate, c.wasm);
    if (!existsSync(path)) {
      console.log(`  ✗ ${c.name}: WASM not found at ${path} — run cargo build first`);
      results.push({ name: c.name, crate: c.crate, contract_hash: "", deploy_hash: "", status: "failed", error: "wasm missing" });
      continue;
    }
    try {
      console.log(`  → installing ${c.name} …`);
      const { deployHash: dh, account } = await installContract({
        wasmPath: path,
        paymentMotes: BigInt(c.paymentCspr) * 1_000_000_000n,
        chainName: env.chainName,
        nodeAddress: env.nodeAddress as string,
        secretKeyPem,
        algorithm: env.algorithm,
      });
      console.log(`    deploy ${dh} submitted, waiting for execution …`);
      const exec = await transport.waitForDeploy(dh, { timeoutMs: 180_000 });
      if (exec.status === "failure") {
        results.push({ name: c.name, crate: c.crate, contract_hash: "", deploy_hash: dh, status: "failed", error: exec.errorMessage });
        console.log(`    ✗ execution failed: ${exec.errorMessage}`);
        continue;
      }
      const contractHash = (await resolveContractHash(env.nodeAddress as string, account, c.namedKeyHints)) ?? "";
      results.push({ name: c.name, crate: c.crate, contract_hash: contractHash, deploy_hash: dh, status: "installed" });
      console.log(`    ✓ ${c.name} -> ${contractHash || "(hash unresolved — check account named keys)"}`);
    } catch (err) {
      results.push({ name: c.name, crate: c.crate, contract_hash: "", deploy_hash: "", status: "failed", error: (err as Error).message });
      console.log(`    ✗ ${c.name}: ${(err as Error).message}`);
    }
  }
  return results;
}

async function main(): Promise<void> {
  const live = isLiveConfigured();
  console.log(
    `Cred402 Testnet deploy (${live ? "LIVE via " + process.env.CRED402_NODE : "DRY RUN — set CRED402_CHAIN=testnet + CRED402_NODE + CRED402_SECRET_KEY for live"})\n`,
  );
  const manifest = live ? await runLive() : await runDryRun();
  const out = resolve(process.cwd(), "deploys.testnet.json");
  writeFileSync(
    out,
    JSON.stringify({ chain: "casper-test", mode: live ? "live" : "dry-run", deployed_at: new Date().toISOString(), contracts: manifest }, null, 2),
  );
  console.log(`\nWrote manifest -> ${out}`);
  if (live && manifest.some((m) => m.status === "failed")) process.exitCode = 1;
}

main().catch((err) => {
  console.error("deploy failed:", (err as Error).message);
  process.exit(1);
});
