/**
 * casper_keygen.ts — generate a fresh, unfunded Casper Testnet ed25519 keypair
 * entirely offline (no network call, no faucet, spends nothing).
 *
 * Writes the PEM under `.secrets/` (gitignored — see .gitignore, never commit
 * it) and prints the account hash + the public faucet URL to fund it. Funding
 * itself is a one-click, captcha-gated step only a human can do — this script
 * deliberately stops short of that and just gets the key ready.
 *
 *   npm run casper:keygen
 *   # then, as the owner: paste the printed account hash into
 *   # https://testnet.cspr.live/tools/faucet
 *   # then set CRED402_CASPER_SECRET_KEY_PEM (or CRED402_SECRET_KEY) to this file.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import Casper from "casper-js-sdk";

const { PrivateKey, KeyAlgorithm } = Casper;

const SECRETS_DIR = join(process.cwd(), ".secrets");
const OUT_PATH = join(SECRETS_DIR, "casper_testnet_secret_key.pem");

function main(): void {
  if (existsSync(OUT_PATH) && !process.argv.includes("--force")) {
    console.log(`A key already exists at ${OUT_PATH} — pass --force to overwrite (this would orphan any funds sent to the old account).`);
    process.exit(1);
  }
  mkdirSync(SECRETS_DIR, { recursive: true });

  const key = PrivateKey.generate(KeyAlgorithm.ED25519);
  const pem = key.toPem();
  writeFileSync(OUT_PATH, pem, { mode: 0o600 });

  const publicKeyHex = key.publicKey.toHex();
  const accountHash = key.publicKey.accountHash().toPrefixedString();

  console.log("Generated a fresh Casper Testnet ed25519 keypair (offline — nothing broadcast, nothing spent).");
  console.log(`  secret key (PEM, gitignored): ${OUT_PATH}`);
  console.log(`  public key:                   ${publicKeyHex}`);
  console.log(`  account hash:                 ${accountHash}`);
  console.log("");
  console.log("OWNER STEP (captcha-gated, cannot be automated):");
  console.log("  1. Open https://testnet.cspr.live/tools/faucet");
  console.log(`  2. Paste the public key above and claim free Testnet CSPR (no payment, no real funds).`);
  console.log("  3. Once funded, set in your .env (or the Render dashboard):");
  console.log(`       CRED402_CASPER_NODE_URL=https://node.testnet.casper.network/rpc`);
  console.log(`       CRED402_CASPER_SECRET_KEY_PEM="$(cat ${OUT_PATH} | sed ':a;N;$!ba;s/\\n/\\\\n/g')"`);
  console.log("     — or, for local dev, just: CRED402_SECRET_KEY=" + OUT_PATH);
  console.log("  4. Restart the API. GET /v1/casper/live will report live:true once reachable.");
}

main();
