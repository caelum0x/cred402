import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

/**
 * Real EVM-family cryptography (secp256k1 + keccak256), used by p3 satellite
 * chains for Address Binding Envelopes, Universal Receipt Envelopes and Credit
 * Authorization Note verification. This is the same primitive stack production
 * libraries (ethers/viem) build on — not a mock.
 */
export interface EvmKeypair {
  privateKey: string; // 0x hex
  publicKey: string; // 0x hex (uncompressed, 65 bytes)
  address: string; // 0x checksum-less lowercase EVM address
}

export function generateEvmKeypair(): EvmKeypair {
  const sk = secp256k1.utils.randomPrivateKey();
  const pk = secp256k1.getPublicKey(sk, false);
  return {
    privateKey: "0x" + bytesToHex(sk),
    publicKey: "0x" + bytesToHex(pk),
    address: addressFromPublicKey(pk),
  };
}

/** Derive the canonical EVM address: last 20 bytes of keccak256(pubkey[1:]). */
export function addressFromPublicKey(pubkey: Uint8Array | string): string {
  const pk = typeof pubkey === "string" ? hexToBytes(pubkey.replace(/^0x/, "")) : pubkey;
  const body = pk.length === 65 ? pk.slice(1) : pk; // drop the 0x04 prefix
  const hash = keccak_256(body);
  return "0x" + bytesToHex(hash.slice(-20));
}

/** keccak256 over the message; the digest signed by EVM keys. */
export function keccak256(input: string | Uint8Array): string {
  const buf = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return "0x" + bytesToHex(keccak_256(buf));
}

/** Sign a message digest with a secp256k1 private key (recoverable signature). */
export function evmSign(privateKeyHex: string, message: string): string {
  const sk = hexToBytes(privateKeyHex.replace(/^0x/, ""));
  const digest = keccak_256(new TextEncoder().encode(message));
  const sig = secp256k1.sign(digest, sk);
  // 65-byte [r||s||v] like an Ethereum signature.
  const compact = sig.toCompactRawBytes();
  const v = sig.recovery! + 27;
  return "0x" + bytesToHex(compact) + v.toString(16).padStart(2, "0");
}

/** Verify a secp256k1 signature over a message, recovering the signer address. */
export function evmRecoverAddress(message: string, signatureHex: string): string | null {
  try {
    const sig = hexToBytes(signatureHex.replace(/^0x/, ""));
    if (sig.length !== 65) return null;
    const compact = sig.slice(0, 64);
    const recovery = sig[64]! - 27;
    const digest = keccak_256(new TextEncoder().encode(message));
    const signature = secp256k1.Signature.fromCompact(compact).addRecoveryBit(recovery);
    const pubkey = signature.recoverPublicKey(digest).toRawBytes(false);
    return addressFromPublicKey(pubkey);
  } catch {
    return null;
  }
}

/** Verify that a signature was produced by the holder of `expectedAddress`. */
export function evmVerify(message: string, signatureHex: string, expectedAddress: string): boolean {
  const recovered = evmRecoverAddress(message, signatureHex);
  return !!recovered && recovered.toLowerCase() === expectedAddress.toLowerCase();
}
