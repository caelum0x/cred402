import { randomBytes } from "node:crypto";
import { blake2b } from "@noble/hashes/blake2b";
import { bytesToHex } from "@noble/hashes/utils";

/**
 * Content hashing.
 *
 * Casper uses blake2b-256 for content addressing. We use the audited @noble/hashes
 * blake2b with a 32-byte digest (the exact algorithm Casper uses), returning a
 * `0x`-prefixed hex string to match the on-chain representation.
 */
export function blake2b256(input: string | Buffer | Uint8Array): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return "0x" + bytesToHex(blake2b(buf, { dkLen: 32 }));
}

/** Hash an arbitrary JSON-able object deterministically (stable key order). */
export function hashObject(obj: unknown): string {
  return blake2b256(stableStringify(obj));
}

/** Deterministic JSON stringify with sorted keys (so hashes are reproducible). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

/** Short id generator used for receipt_id / evidence_id / deploy hashes. */
export function shortId(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString("hex")}`;
}

/**
 * A Casper transaction (deploy) hash — 32 random bytes as 64 hex chars. Each
 * ledger contract call mints one to stamp its emitted event, exactly as an
 * on-chain transaction would. On Testnet this is replaced by the hash the node
 * returns; the local ledger generates it so event provenance is consistent.
 */
export function deployHash(): string {
  return randomBytes(32).toString("hex");
}
