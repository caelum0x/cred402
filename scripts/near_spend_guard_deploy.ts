/**
 * near_spend_guard_deploy.ts — deploy the SpendGuard contract
 * (contracts-near/spend_guard) to a fresh NEAR Testnet account, fully
 * programmatically.
 *
 * The hackathon plan's own pre-work rehearsal found that `cargo near
 * create-dev-account` and `cargo near deploy ... sign-with-keychain send`
 * are both fully interactive (they refuse piped stdin), so this script
 * drives the real deploy via `near-api-js` directly instead of shelling out
 * to that CLI:
 *   1. Generate a fresh ed25519 keypair locally (no network call).
 *   2. Create a brand-new named `*.testnet` account for free via the
 *      public, non-captcha faucet API (`POST
 *      https://helper.testnet.near.org/account`) — the same endpoint
 *      already proven to work for named subaccounts in this repo's NEAR
 *      x402 verification pass (see `plans/cred402.md`, tx
 *      `C1LNxQFEaR2AQj79U9WzToiB1eY86jwzmxoHKvr9W7jk`).
 *   3. Deploy the built wasm (`cargo near build non-reproducible-wasm`
 *      output) to that account.
 *   4. Call `new({ admin: <account_id> })` to initialize contract state.
 *
 *   npm run near:spend-guard:deploy
 *
 * Credentials are written to `.secrets/near_spend_guard_credentials.json`
 * (gitignored, mode 0600) — nothing here is a secret baked into source.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Account, JsonRpcProvider, KeyPair } from "near-api-js";

// See `lib/x402/near_networks.ts::DEFAULT_NEAR_RPC_URL` for why this
// defaults to FastNear rather than NEAR's own now-rate-limited legacy
// public RPC (`rpc.testnet.near.org`, confirmed live 2026-11-05).
const RPC_URL = process.env.CRED402_NEAR_RPC_URL?.trim() || "https://rpc.testnet.fastnear.com";
const FAUCET_URL = "https://helper.testnet.near.org/account";
const SECRETS_DIR = join(process.cwd(), ".secrets");
const OUT_PATH = join(SECRETS_DIR, "near_spend_guard_credentials.json");
const WASM_PATH = join(process.cwd(), "contracts-near/spend_guard/target/near/spend_guard.wasm");

function randomAccountSuffix(): string {
  return randomBytes(5).toString("hex");
}

async function createTestnetAccount(accountId: string, publicKey: string): Promise<void> {
  const res = await fetch(FAUCET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`faucet account creation for ${accountId} failed (HTTP ${res.status}): ${body}`);
  }
  console.log(`faucet response for ${accountId}: ${body.slice(0, 200)}`);
}

async function main(): Promise<void> {
  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `${WASM_PATH} not found — run \`cd contracts-near/spend_guard && cargo near build non-reproducible-wasm\` first`,
    );
  }
  if (existsSync(OUT_PATH) && !process.argv.includes("--force")) {
    const existing = JSON.parse(readFileSync(OUT_PATH, "utf8")) as { account_id: string };
    console.log(
      `Credentials already exist at ${OUT_PATH} for ${existing.account_id} — pass --force to deploy a fresh contract account instead.`,
    );
    console.log(`CRED402_NEAR_SPEND_GUARD_CONTRACT=${existing.account_id}`);
    return;
  }

  mkdirSync(SECRETS_DIR, { recursive: true });

  const keyPair = KeyPair.fromRandom("ed25519");
  const accountId = `spendguard-${randomAccountSuffix()}.testnet`;
  const publicKey = keyPair.getPublicKey().toString();

  console.log(`Creating real NEAR Testnet account ${accountId} via the public faucet (no owner credential used)...`);
  await createTestnetAccount(accountId, publicKey);

  const provider = new JsonRpcProvider({ url: RPC_URL });
  const account = new Account(accountId, provider, keyPair.toString());

  const wasm = readFileSync(WASM_PATH);
  console.log(`Deploying ${wasm.length} bytes of real contract wasm to ${accountId} on ${RPC_URL}...`);
  const deployResult = await account.deployContract(new Uint8Array(wasm));
  console.log("deploy tx:", JSON.stringify(deployResult, null, 2).slice(0, 1000));

  console.log(`Calling new({ admin: "${accountId}" }) to initialize contract state...`);
  const initResult = await account.callFunction({
    contractId: accountId,
    methodName: "new",
    args: { admin: accountId },
    gas: 100_000_000_000_000n,
  });
  console.log("init result:", initResult);

  const credentials = {
    account_id: accountId,
    public_key: publicKey,
    private_key: keyPair.toString(),
    network: "testnet",
    rpc_url: RPC_URL,
  };
  writeFileSync(OUT_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  console.log("");
  console.log(`Real deploy complete. Credentials written to ${OUT_PATH} (gitignored).`);
  console.log(`CRED402_NEAR_SPEND_GUARD_CONTRACT=${accountId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
