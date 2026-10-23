/**
 * near_keygen.ts — generate a fresh NEAR Testnet ed25519 keypair entirely
 * offline (no network call, spends nothing).
 *
 * NEAR has "implicit accounts": the 64-hex-char encoding of the ed25519
 * public key IS a valid account id, and it becomes a real on-chain account
 * automatically the first time it receives a transfer — no separate
 * registration step. That means the public key derived here can go straight
 * into CRED402_NEAR_PAY_TO once funded.
 *
 *   npm run near:keygen
 *   # then, as the owner: fund the printed implicit account at
 *   # https://near-faucet.io (free testnet NEAR, no real funds)
 *   # then set CRED402_NEAR_PAY_TO to the implicit account id.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { KeyPair } from "near-api-js";

const SECRETS_DIR = join(process.cwd(), ".secrets");
const OUT_PATH = join(SECRETS_DIR, "near_testnet_credentials.json");

function main(): void {
  if (existsSync(OUT_PATH) && !process.argv.includes("--force")) {
    console.log(`A key already exists at ${OUT_PATH} — pass --force to overwrite (this would orphan any funds sent to the old account).`);
    process.exit(1);
  }
  mkdirSync(SECRETS_DIR, { recursive: true });

  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey();
  const implicitAccountId = Buffer.from(publicKey.data).toString("hex");

  const credentials = {
    account_id: implicitAccountId,
    public_key: publicKey.toString(),
    private_key: keyPair.toString(),
  };
  writeFileSync(OUT_PATH, JSON.stringify(credentials, null, 2), { mode: 0o600 });

  console.log("Generated a fresh NEAR Testnet ed25519 keypair (offline — nothing broadcast, nothing spent).");
  console.log(`  credentials (gitignored): ${OUT_PATH}`);
  console.log(`  implicit account id:      ${implicitAccountId}`);
  console.log(`  public key:               ${publicKey.toString()}`);
  console.log("");
  console.log("OWNER STEP (captcha-gated, cannot be automated):");
  console.log("  1. Open https://near-faucet.io");
  console.log(`  2. Paste the implicit account id above and claim free Testnet NEAR (no payment, no real funds).`);
  console.log("     This both funds AND creates the account on-chain in one step.");
  console.log("  3. Once funded, set in your .env (or the Render dashboard):");
  console.log(`       CRED402_NEAR_PAY_TO=${implicitAccountId}`);
  console.log("       CRED402_NEAR_NETWORK=testnet");
  console.log("  4. Restart the API. GET /v1/x402/near/status will report ready:true once reachable + funded.");
}

main();
