/**
 * near_spend_guard_full_demo.ts — Day 11's "one command a judge can run"
 * for the SpendGuard contract: builds the real contract wasm, runs the
 * full automated test pass (14 Rust unit tests + a near-workspaces sandbox
 * integration test exercising the ENTIRE loop — earn, policy, a capped
 * spend key, real spends, a genuine nearcore allowance rejection, a
 * dispute spike, a freeze, and a genuine nearcore deleted-key rejection —
 * against a real local nearcore node, zero manual steps), then, if a real
 * Testnet deploy already exists (`scripts/near_spend_guard_deploy.ts`),
 * runs a small real end-to-end loop against the LIVE deployed contract on
 * NEAR Testnet as a bonus live artifact.
 *
 *   npm run demo:near-spend-guard
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { SpendGuardClient } from "../lib/x402/near_spend_guard_client.js";
import { NearSpendControlledBuyerAgent } from "../agents/near_spend_controlled_buyer_agent.js";
import { NearWatchdogAgent } from "../agents/near_watchdog_agent.js";
import type { KeyPairString } from "near-api-js";

const CONTRACT_DIR = join(process.cwd(), "contracts-near", "spend_guard");
const CREDENTIALS_PATH = join(process.cwd(), ".secrets", "near_spend_guard_credentials.json");

function run(label: string, command: string, args: string[], cwd: string): void {
  console.log(`\n=== ${label} (${command} ${args.join(" ")}) ===`);
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function runLiveTestnetLoop(): Promise<void> {
  if (!existsSync(CREDENTIALS_PATH)) {
    console.log(
      `\n(No real Testnet deploy found at ${CREDENTIALS_PATH} — run \`npm run near:spend-guard:deploy\` first ` +
        "for a live-network bonus run. The sandbox test above already fully proves the loop; this step is optional.)",
    );
    return;
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as {
    account_id: string;
    private_key: KeyPairString;
    rpc_url: string;
  };
  console.log(`\n=== Live Testnet bonus run against ${credentials.account_id} ===`);

  const config = { contractId: credentials.account_id, rpcUrl: credentials.rpc_url };
  const adminClient = SpendGuardClient.withSecretKey(config, credentials.account_id, credentials.private_key);

  const agentId = `demo-buyer-${Date.now()}`;
  const agent = new NearSpendControlledBuyerAgent(config, agentId);
  console.log(`Authorizing ${agentId} with a fresh real ed25519 key (${agent.publicKey})...`);
  await agent.getAuthorized(adminClient, {
    revenue_30d: "1000000000000000000000000", // 1 NEAR -> credit_line 0.3 NEAR
    stake: "0",
    dispute_rate_bps: 0,
    accuracy_score: 100,
    total_jobs: 5,
  });
  const record = await adminClient.getAgent(agentId);
  console.log("real on-chain agent record:", record);

  const seller = credentials.account_id; // self-loop for the demo; any funded account works
  // Dust-sized amount so the real spend's VALUE never binds the cap — this
  // run is specifically showing nearcore's own prepaid-gas allowance
  // running out, the same real protocol mechanic `tests/sandbox.rs` proves
  // deterministically against the local sandbox.
  const spendResults = await agent.spendRepeatedly(seller, "1", 25);
  console.log("real spend attempts:", spendResults);

  const scammerId = `demo-scammer-${Date.now()}`;
  const scammer = new NearSpendControlledBuyerAgent(config, scammerId);
  await scammer.getAuthorized(adminClient, {
    revenue_30d: "1000000000000000000000000",
    stake: "0",
    dispute_rate_bps: 0,
    accuracy_score: 100,
    total_jobs: 5,
  });
  console.log(`Authorized ${scammerId}; simulating a dispute-rate spike...`);

  const watchdog = new NearWatchdogAgent(adminClient);
  await watchdog.reportDisputeSpike(scammerId, 5);
  console.log("frozen:", await watchdog.isFrozen(scammerId));
  console.log("key_active:", await watchdog.isKeyActive(scammerId));

  const postFreezeAttempt = await scammer.spendRepeatedly(seller, "1", 1);
  console.log("post-freeze spend attempt (must fail):", postFreezeAttempt);
  if (postFreezeAttempt[0]?.success) {
    throw new Error("a revoked key must never be able to spend again on the live network either");
  }

  console.log("\nLive Testnet loop verified for real:", {
    contract: credentials.account_id,
    rpc: credentials.rpc_url,
    buyer_credit_line: record?.credit_line,
    real_spends: spendResults.filter((r) => r.success).length,
    scammer_frozen: await watchdog.isFrozen(scammerId),
  });
}

async function main(): Promise<void> {
  run("Build contract wasm", "cargo", ["near", "build", "non-reproducible-wasm"], CONTRACT_DIR);
  run("Full automated test pass (unit + sandbox)", "cargo", ["test"], CONTRACT_DIR);
  await runLiveTestnetLoop();
  console.log("\ndemo:near-spend-guard complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
