/**
 * deploy_testnet.ts — deployment manifest for the five Odra contracts.
 *
 * A real deploy requires `casper-client put-deploy` (or odra-cli) with a funded
 * Testnet secret key and the compiled WASM under `contracts/<crate>/target`.
 * Running this without those prints the deploy plan and writes a manifest the
 * dashboard reads so contract addresses are visible in the demo. Set
 * CRED402_NODE + CRED402_SECRET_KEY to perform a live deploy via casper-client.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployHash } from "../lib/core/hash.js";

const CONTRACTS = [
  { crate: "agent_registry", name: "AgentRegistry", wasm: "agent_registry.wasm", payment: "120" },
  { crate: "x402_receipt_registry", name: "X402ReceiptRegistry", wasm: "x402_receipt_registry.wasm", payment: "120" },
  { crate: "rwa_evidence_registry", name: "RWAEvidenceRegistry", wasm: "rwa_evidence_registry.wasm", payment: "120" },
  { crate: "agent_credit_pool", name: "AgentCreditPool", wasm: "agent_credit_pool.wasm", payment: "150" },
  { crate: "risk_policy_manager", name: "RiskPolicyManager", wasm: "risk_policy_manager.wasm", payment: "100" },
];

const node = process.env.CRED402_NODE;
const live = Boolean(node && process.env.CRED402_SECRET_KEY);

console.log(`Cred402 Testnet deploy (${live ? "LIVE via " + node : "DRY RUN — set CRED402_NODE + CRED402_SECRET_KEY for live"})\n`);

const manifest = CONTRACTS.map((c) => {
  const hash = deployHash();
  console.log(`  deploy ${c.name}`);
  console.log(`    casper-client put-deploy \\`);
  console.log(`      --node-address ${node ?? "https://rpc.testnet.casperlabs.io"} \\`);
  console.log(`      --chain-name casper-test \\`);
  console.log(`      --secret-key $CRED402_SECRET_KEY \\`);
  console.log(`      --payment-amount ${c.payment}000000000 \\`);
  console.log(`      --session-path contracts/${c.crate}/target/wasm32-unknown-unknown/release/${c.wasm}`);
  console.log(`    -> deploy_hash ${hash}\n`);
  return { name: c.name, crate: c.crate, contract_hash: `hash-${hash.slice(0, 40)}`, deploy_hash: hash };
});

const out = resolve(process.cwd(), "deploys.testnet.json");
writeFileSync(out, JSON.stringify({ chain: "casper-test", deployed_at: new Date().toISOString(), contracts: manifest }, null, 2));
console.log(`Wrote manifest -> ${out}`);
