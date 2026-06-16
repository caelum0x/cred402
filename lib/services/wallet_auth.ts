import { randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { blake2b } from "@noble/hashes/blake2b";

/**
 * Sign-in with Casper Wallet — a real challenge/response auth flow that proves a
 * user controls a Casper account, without any private key ever leaving the wallet
 * extension. The server issues a one-time nonce; the wallet signs it (ed25519); the
 * server verifies the signature against the account's public key and mints a short
 * session token. This is the backend counterpart to the frontend `useCasperWallet`
 * hook's `signMessage`.
 */

export interface WalletChallenge {
  account: string; // Casper public key hex ("01" + 64 hex for ed25519)
  nonce: string;
  message: string; // the exact string the wallet should sign
  issued_at: number;
  expires_at: number;
}

export interface WalletSession {
  account: string;
  token: string;
  issued_at: number;
  expires_at: number;
}

const CHALLENGE_TTL_SECONDS = 5 * 60; // 5 minutes to sign
const SESSION_TTL_SECONDS = 24 * 60 * 60; // 24h session
const ED25519_TAG = "01"; // Casper algorithm prefix for ed25519 keys

function isEd25519CasperKey(hex: string): boolean {
  return /^01[0-9a-fA-F]{64}$/.test(hex);
}

/** Verify a Casper-Wallet-signed message against an ed25519 account key. Accepts
 * both the raw-message signature and the Casper "Casper Message:\n"+message blake2b
 * digest variant, so it works whichever the wallet produced. */
export function verifyCasperSignature(accountHex: string, message: string, signatureHex: string): boolean {
  if (!isEd25519CasperKey(accountHex)) return false;
  const sig = signatureHex.replace(/^0x/, "").replace(/^01/, ""); // tolerate a leading algo tag
  let signature: Uint8Array;
  let pub: Uint8Array;
  try {
    signature = hexToBytes(sig);
    pub = hexToBytes(accountHex.slice(ED25519_TAG.length)); // raw 32-byte key
  } catch {
    return false;
  }
  if (signature.length !== 64 || pub.length !== 32) return false;

  const raw = new TextEncoder().encode(message);
  const casperWrapped = blake2b(new TextEncoder().encode(`Casper Message:\n${message}`), { dkLen: 32 });
  for (const msg of [raw, casperWrapped]) {
    try {
      if (ed25519.verify(signature, msg, pub)) return true;
    } catch {
      /* try the next variant */
    }
  }
  return false;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class WalletAuth {
  private readonly challenges = new Map<string, WalletChallenge>(); // nonce → challenge
  private readonly sessions = new Map<string, WalletSession>(); // token → session

  constructor(private readonly now: () => number = () => Math.floor(Date.now() / 1000)) {}

  /** Issue a one-time challenge for an account to sign. */
  challenge(accountHex: string): WalletChallenge | { error: string } {
    if (!isEd25519CasperKey(accountHex)) return { error: "expected a Casper ed25519 public key (01 + 64 hex)" };
    const nonce = randomBytes(16).toString("hex");
    const issued = this.now();
    const challenge: WalletChallenge = {
      account: accountHex,
      nonce,
      message: `Cred402 wallet sign-in\naccount: ${accountHex}\nnonce: ${nonce}`,
      issued_at: issued,
      expires_at: issued + CHALLENGE_TTL_SECONDS,
    };
    this.challenges.set(nonce, challenge);
    return challenge;
  }

  /** Verify a signed challenge and mint a session on success. */
  verify(nonce: string, signatureHex: string): WalletSession | { error: string } {
    const challenge = this.challenges.get(nonce);
    if (!challenge) return { error: "unknown or already-used challenge" };
    if (this.now() > challenge.expires_at) {
      this.challenges.delete(nonce);
      return { error: "challenge expired" };
    }
    if (!verifyCasperSignature(challenge.account, challenge.message, signatureHex)) {
      return { error: "signature verification failed" };
    }
    this.challenges.delete(nonce); // one-time use
    const token = randomBytes(24).toString("hex");
    const issued = this.now();
    const session: WalletSession = { account: challenge.account, token, issued_at: issued, expires_at: issued + SESSION_TTL_SECONDS };
    this.sessions.set(token, session);
    return session;
  }

  /** Resolve a session token to its account, or null if invalid/expired. */
  session(token: string): WalletSession | null {
    const s = this.sessions.get(token);
    if (!s) return null;
    if (this.now() > s.expires_at) {
      this.sessions.delete(token);
      return null;
    }
    return s;
  }
}
