/**
 * near_spend_guard_redeploy.ts — upgrade the WASM code on the ALREADY-
 * deployed SpendGuard Testnet contract (`.secrets/near_spend_guard_credentials.json`)
 * without touching its existing on-chain state.
 *
 * Unlike `near_spend_guard_deploy.ts` (which creates a brand-new account),
 * this redeploys code to the SAME account id so the contract's existing
 * `AgentRecord`/`ExposureBook`/dispute-count storage survives untouched —
 * real NEAR behavior: a `DeployContract` action only replaces the account's
 * code, never its storage. Deliberately does NOT call `new(...)` again:
 * `#[init]` without `ignore_state` panics ("Already initialized") on an
 * account whose state already exists, which is exactly the safety property
 * we want here — this script only ever upgrades code, never re-inits.
 *
 *   npm run near:spend-guard:redeploy
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

const SECRETS_DIR = join(process.cwd(), ".secrets");
const CREDENTIALS_PATH = join(SECRETS_DIR, "near_spend_guard_credentials.json");
const WASM_PATH = join(process.cwd(), "contracts-near/spend_guard/target/near/spend_guard.wasm");

async function main(): Promise<void> {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(`${CREDENTIALS_PATH} not found — run \`npm run near:spend-guard:deploy\` first`);
  }
  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `${WASM_PATH} not found — run \`cd contracts-near/spend_guard && cargo near build non-reproducible-wasm\` first`,
    );
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, "utf8")) as {
    account_id: string;
    private_key: KeyPairString;
    rpc_url: string;
  };

  const provider = new JsonRpcProvider({ url: credentials.rpc_url });
  const account = new Account(credentials.account_id, provider, credentials.private_key);

  const wasm = readFileSync(WASM_PATH);
  console.log(
    `Redeploying ${wasm.length} bytes of upgraded contract wasm to the EXISTING account ` +
      `${credentials.account_id} (state preserved)...`,
  );
  const deployResult = await account.deployContract(new Uint8Array(wasm));
  console.log("redeploy tx:", JSON.stringify(deployResult, null, 2).slice(0, 1000));

  const admin = await account.provider.callFunction<string>({
    contractId: credentials.account_id,
    method: "admin",
    args: {},
  });
  console.log(`Post-redeploy sanity check — admin() still returns: ${admin}`);
  if (admin !== credentials.account_id) {
    throw new Error(`unexpected admin() after redeploy: ${admin}`);
  }
  console.log("Redeploy complete. Existing agent/exposure state preserved.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
