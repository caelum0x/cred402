import { test } from "node:test";
import assert from "node:assert/strict";
import { ed25519 } from "@noble/curves/ed25519";

import { WalletAuth, verifyCasperSignature } from "../lib/services/wallet_auth.js";
import { ServerState } from "../api/state.js";

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

function keypair() {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv, account: "01" + toHex(pub) };
}

test("wallet auth: challenge → sign → verify mints a session", () => {
  const { priv, account } = keypair();
  const auth = new WalletAuth();
  const ch = auth.challenge(account);
  assert.ok(!("error" in ch));
  if ("error" in ch) return;
  const sig = ed25519.sign(new TextEncoder().encode(ch.message), priv);
  const session = auth.verify(ch.nonce, toHex(sig));
  assert.ok(!("error" in session));
  if ("error" in session) return;
  assert.equal(session.account, account);
  assert.ok(session.token.length > 0);
  // the session resolves
  assert.equal(auth.session(session.token)?.account, account);
});

test("wallet auth: the nonce is one-time (replay rejected)", () => {
  const { priv, account } = keypair();
  const auth = new WalletAuth();
  const ch = auth.challenge(account) as { nonce: string; message: string };
  const sig = toHex(ed25519.sign(new TextEncoder().encode(ch.message), priv));
  auth.verify(ch.nonce, sig);
  const replay = auth.verify(ch.nonce, sig);
  assert.ok("error" in replay);
});

test("wallet auth: a wrong signer fails verification", () => {
  const { account } = keypair();
  const other = keypair();
  const auth = new WalletAuth();
  const ch = auth.challenge(account) as { nonce: string; message: string };
  // sign with a different key
  const sig = toHex(ed25519.sign(new TextEncoder().encode(ch.message), other.priv));
  const r = auth.verify(ch.nonce, sig);
  assert.ok("error" in r);
});

test("wallet auth: an expired challenge cannot be used", () => {
  let t = 1000;
  const { priv, account } = keypair();
  const auth = new WalletAuth(() => t);
  const ch = auth.challenge(account) as { nonce: string; message: string };
  const sig = toHex(ed25519.sign(new TextEncoder().encode(ch.message), priv));
  t += 10 * 60; // 10 minutes later, past the 5-minute TTL
  const r = auth.verify(ch.nonce, sig);
  assert.ok("error" in r);
  assert.match((r as { error: string }).error, /expired/);
});

test("wallet auth: rejects non-ed25519 Casper keys", () => {
  const auth = new WalletAuth();
  assert.ok("error" in auth.challenge("02abcdef")); // secp256k1 tag / wrong length
  assert.equal(verifyCasperSignature("nonsense", "msg", "00"), false);
});

test("wallet auth: a session lists only the account's owned agents", () => {
  const state = new ServerState();
  const { priv, account } = keypair();
  state.ledger.agents.register_agent({ agent_id: "Owned", owner_public_key: account, agent_public_key: account, service_type: "monitoring" });

  const ch = state.walletChallenge(account) as { nonce: string; message: string };
  const sig = toHex(ed25519.sign(new TextEncoder().encode(ch.message), priv));
  const session = state.walletVerify(ch.nonce, sig) as { token: string };

  const mine = state.walletAgents(session.token) as { count: number; agents: { agent_id: string }[] };
  assert.equal(mine.count, 1);
  assert.equal(mine.agents[0]!.agent_id, "Owned");
  assert.ok("error" in (state.walletAgents("not-a-token") as object));
});
