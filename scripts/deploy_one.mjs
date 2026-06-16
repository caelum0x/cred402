/**
 * deploy_one.mjs — install ONE compiled Odra contract WASM to Casper Testnet
 * from the funded deployer key, wait for execution, and resolve the on-chain
 * contract hash from the deployer account's named keys.
 *
 *   node scripts/deploy_one.mjs <crate> <namedKeyHint> [paymentCSPR]
 *   e.g. node scripts/deploy_one.mjs agent_registry agent_registry 300
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import Casper from "casper-js-sdk";

const {
  Args, CLValue, Deploy, DeployHeader, Duration, ExecutableDeployItem,
  HttpHandler, KeyAlgorithm, PrivateKey, RpcClient, Timestamp,
} = Casper;

const NODE = process.env.CRED402_NODE ?? "https://node.testnet.casper.network/rpc";
const CHAIN = process.env.CRED402_CHAIN_NAME ?? "casper-test";
const KEY = process.env.CRED402_SECRET_KEY ?? ".secrets/testnet_deployer.pem";

const crate = process.argv[2];
const hint = process.argv[3] ?? crate;
const paymentCspr = BigInt(process.argv[4] ?? "300");
const wasmPath = `contracts/target/wasm32-unknown-unknown/release/${crate}_build_contract.wasm`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rpcCall(method, params) {
  const res = await fetch(NODE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${j.error.message} ${JSON.stringify(j.error.data ?? "")}`);
  return j.result;
}

async function main() {
  if (!existsSync(wasmPath)) throw new Error(`wasm not found: ${wasmPath} (build it first)`);
  const key = PrivateKey.fromPem(readFileSync(KEY, "utf8"), KeyAlgorithm.ED25519);
  const pubHex = key.publicKey.toHex();
  const wasm = new Uint8Array(readFileSync(wasmPath));
  console.log(`Deploying ${crate} (${(wasm.length / 1024).toFixed(0)} KB) as ${pubHex.slice(0, 12)}… payment ${paymentCspr} CSPR`);

  // Odra installer config args (read by the contract's generated call()).
  const installArgs = Args.fromMap({
    odra_cfg_package_hash_key_name: CLValue.newCLString(`${crate}_package`),
    odra_cfg_allow_key_override: CLValue.newCLValueBool(true),
    odra_cfg_is_upgradable: CLValue.newCLValueBool(false),
    odra_cfg_constructor: CLValue.newCLString("init"),
  });
  const session = ExecutableDeployItem.newModuleBytes(wasm, installArgs);
  const payment = ExecutableDeployItem.standardPayment((paymentCspr * 1_000_000_000n).toString());
  const header = new DeployHeader(CHAIN, [], 1, new Timestamp(new Date()), new Duration(1_800_000), key.publicKey);
  const deploy = Deploy.makeDeploy(header, payment, session);
  deploy.sign(key);
  if (!deploy.validate()) throw new Error("deploy failed self-validation");

  const hash = deploy.hash.toHex();
  const rpc = new RpcClient(new HttpHandler(NODE));
  await rpc.putDeploy(deploy);
  console.log(`  submitted deploy ${hash}`);
  console.log(`  https://testnet.cspr.live/deploy/${hash}`);

  // Poll for execution.
  let exec = null;
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    try {
      const r = await rpcCall("info_get_deploy", { deploy_hash: hash });
      const er = r.execution_results ?? r.execution_info?.execution_result;
      const arr = Array.isArray(er) ? er : er ? [{ result: er }] : [];
      const result = arr[0]?.result ?? r.execution_info?.execution_result;
      if (result) { exec = result; break; }
      if (r.execution_info?.execution_result) { exec = r.execution_info.execution_result; break; }
    } catch (e) { /* not yet */ }
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  const success = exec && (exec.Success || exec.Version2?.error_message == null && exec.Version2);
  const failure = exec && (exec.Failure || exec.Version2?.error_message);
  if (failure && (exec.Failure?.error_message || exec.Version2?.error_message)) {
    console.log(`  ✗ execution FAILED: ${exec.Failure?.error_message ?? exec.Version2?.error_message}`);
    process.exit(2);
  }
  console.log(`  ✓ executed (success)`);

  // Resolve the contract hash from the account's named keys (Casper 2.0 entity).
  let contractHash = "";
  try {
    const ent = await rpcCall("state_get_entity", { entity_identifier: { PublicKey: pubHex } });
    const nks = ent.entity?.named_keys ?? ent.named_keys ?? [];
    const match = nks.find((k) => k.name === hint) || nks.find((k) => k.name.includes(hint));
    contractHash = match?.key ?? "";
    if (!contractHash && nks.length) console.log("  named keys:", nks.map((k) => k.name).join(", "));
  } catch (e) { console.log("  (named-key lookup:", e.message, ")"); }

  console.log(`  contract_hash: ${contractHash || "(unresolved — see named keys above)"}`);

  // Append to deploys.testnet.json
  const out = "deploys.testnet.json";
  const manifest = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : { chain: CHAIN, mode: "live", contracts: [] };
  manifest.mode = "live";
  manifest.deployed_at = new Date().toISOString();
  manifest.contracts = (manifest.contracts || []).filter((c) => c.crate !== crate);
  manifest.contracts.push({ name: hint, crate, contract_hash: contractHash, deploy_hash: hash, status: "installed" });
  writeFileSync(out, JSON.stringify(manifest, null, 2));
  console.log(`  recorded -> ${out}`);
}

main().catch((e) => { console.error("deploy failed:", e.message); process.exit(1); });
