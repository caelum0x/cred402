import type { ServiceType } from "../core/types.js";
import { blake2b256 } from "../core/hash.js";
import { sign, verifyCasperHex } from "./keys.js";
import { paymentAuthorizationDigest } from "./eip712.js";

/**
 * x402 — HTTP-native machine-to-machine payments.
 *
 * Flow (matches Casper's AI Toolkit x402 story):
 *   1. Buyer hits a paid endpoint.
 *   2. Server replies `402 Payment Required` with a signed PaymentChallenge.
 *   3. Buyer signs a domain-separated PaymentAuthorization (casper-eip-712 style)
 *      and retries with an `X-Payment` header.
 *   4. Server verifies the proof, delivers the report, and records a receipt.
 */

export const X402_DOMAIN = {
  name: "Cred402",
  version: "1",
  network: "casper-testnet",
} as const;

export interface PaymentChallenge {
  payment_id: string;
  amount_motes: string;
  network: "casper";
  asset: "CSPR";
  resource: string;
  service_type: ServiceType;
  seller_agent: string;
  nonce: string;
  expires_at: number;
}

/** The structured, domain-separated message an agent signs to authorize payment. */
export interface PaymentAuthorization {
  domain: typeof X402_DOMAIN;
  payment_id: string;
  payer_agent: string;
  seller_agent: string;
  service_type: ServiceType;
  amount_motes: string;
  resource: string;
  nonce: string;
}

export interface PaymentProof {
  authorization: PaymentAuthorization;
  payer_public_key: string;
  signature: string;
}

/**
 * The 32-byte EIP-712 typed-data digest that gets signed — a standards-compliant
 * `\x19\x01` typed-data hash (via `@casper-ecosystem/casper-eip-712`), verifiable
 * by any EIP-712-aware contract or the casper-x402 facilitator, not just by us.
 */
export function authorizationDigest(auth: PaymentAuthorization): string {
  return paymentAuthorizationDigest(auth);
}

/** Buyer side: sign a PaymentAuthorization with the agent's ed25519 key. */
export function signPayment(args: {
  challenge: PaymentChallenge;
  payer_agent: string;
  payer_public_key: string;
  payer_private_pem: string;
}): { header: string; proof: PaymentProof } {
  const authorization: PaymentAuthorization = {
    domain: X402_DOMAIN,
    payment_id: args.challenge.payment_id,
    payer_agent: args.payer_agent,
    seller_agent: args.challenge.seller_agent,
    service_type: args.challenge.service_type,
    amount_motes: args.challenge.amount_motes,
    resource: args.challenge.resource,
    nonce: args.challenge.nonce,
  };
  const signature = sign(args.payer_private_pem, authorizationDigest(authorization));
  const proof: PaymentProof = {
    authorization,
    payer_public_key: args.payer_public_key,
    signature,
  };
  // The X-Payment header carries the base64-encoded proof, per x402 convention.
  const header = Buffer.from(JSON.stringify(proof), "utf8").toString("base64");
  return { header, proof };
}

export function decodePaymentHeader(header: string): PaymentProof {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as PaymentProof;
}

/** Seller side: verify a payment proof matches the challenge and signature. */
export function verifyPayment(args: {
  challenge: PaymentChallenge;
  proof: PaymentProof;
  now?: number;
}): { ok: boolean; reason?: string } {
  const { challenge, proof } = args;
  const a = proof.authorization;
  if (a.payment_id !== challenge.payment_id) return { ok: false, reason: "payment_id mismatch" };
  if (a.amount_motes !== challenge.amount_motes) return { ok: false, reason: "amount mismatch" };
  if (a.nonce !== challenge.nonce) return { ok: false, reason: "nonce mismatch" };
  if (a.seller_agent !== challenge.seller_agent) return { ok: false, reason: "seller mismatch" };
  if (a.domain.network !== X402_DOMAIN.network) return { ok: false, reason: "wrong network" };
  // Reject expired challenges (replay window protection, p2 §14 threat 2).
  if (args.now !== undefined && args.now > challenge.expires_at) return { ok: false, reason: "challenge expired" };
  const validSig = verifyCasperHex(proof.payer_public_key, authorizationDigest(a), proof.signature);
  if (!validSig) return { ok: false, reason: "invalid signature" };
  return { ok: true };
}

/** The on-chain commitment hash stored in the X402ReceiptRegistry. */
export function paymentProofHash(proof: PaymentProof): string {
  return blake2b256(JSON.stringify(proof));
}

/** Render the 402 response headers an agent endpoint returns. */
export function challengeHeaders(challenge: PaymentChallenge): Record<string, string> {
  return {
    "X-Payment-Amount": (Number(challenge.amount_motes) / 1e9).toString(),
    "X-Payment-Amount-Motes": challenge.amount_motes,
    "X-Payment-Network": challenge.network,
    "X-Payment-Asset": challenge.asset,
    "X-Payment-Id": challenge.payment_id,
    "X-Payment-Nonce": challenge.nonce,
    "X-Payment-Resource": challenge.resource,
  };
}
