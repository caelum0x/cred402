import {
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  createPrivateKey,
  type KeyObject,
} from "node:crypto";

/**
 * Ed25519 agent identities.
 *
 * On Casper, account abstraction lets an agent operate with its own on-chain
 * identity (ed25519 / secp256k1 key) instead of a human wallet. We generate
 * ed25519 keypairs — the same curve Casper supports — and expose Casper-style
 * `01`-prefixed hex public keys for display.
 */
export interface AgentKeypair {
  publicKeyHex: string; // Casper-style "01" + 32-byte hex
  privatePem: string;
  publicPem: string;
}

export function generateAgentKeypair(): AgentKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyHex: casperPublicKeyHex(publicKey),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** Extract the raw 32-byte ed25519 public key and format as Casper "01"+hex. */
export function casperPublicKeyHex(pub: KeyObject): string {
  const spki = pub.export({ type: "spki", format: "der" });
  // The raw key is the trailing 32 bytes of the SPKI DER for ed25519.
  const raw = spki.subarray(spki.length - 32);
  return "01" + raw.toString("hex");
}

export function sign(privatePem: string, message: string): string {
  const key = createPrivateKey(privatePem);
  return edSign(null, Buffer.from(message, "utf8"), key).toString("hex");
}

export function verify(publicPem: string, message: string, signatureHex: string): boolean {
  try {
    const key = createPublicKey(publicPem);
    return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}

/** Standard SPKI DER header for an ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Reconstruct a KeyObject from a Casper-style "01"+hex ed25519 public key. */
export function publicKeyFromCasperHex(casperHex: string): KeyObject {
  const hex = casperHex.startsWith("01") ? casperHex.slice(2) : casperHex;
  const raw = Buffer.from(hex, "hex");
  if (raw.length !== 32) throw new Error("expected 32-byte ed25519 public key");
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Verify a signature directly against a Casper-style "01"+hex public key. */
export function verifyCasperHex(casperHex: string, message: string, signatureHex: string): boolean {
  try {
    const key = publicKeyFromCasperHex(casperHex);
    return edVerify(null, Buffer.from(message, "utf8"), key, Buffer.from(signatureHex, "hex"));
  } catch {
    return false;
  }
}
