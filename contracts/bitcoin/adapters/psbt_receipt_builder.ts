/**
 * Cred402 Bitcoin adapter — PSBT Receipt Builder.
 *
 * Builds a Cred402 receipt commitment from a PSBT-like input. Bitcoin is a
 * payment/evidence reference only — this adapter does NOT broadcast or sign; it
 * deterministically derives:
 *
 *   1. the legacy Bitcoin `txid` of the (unsigned) transaction skeleton described
 *      by the PSBT-like input, computed as the standard double-SHA256 of the
 *      consensus-serialized transaction, displayed in little-endian (RPC) byte
 *      order; and
 *   2. a `receipt_commitment` — a `0x`-prefixed 32-byte sha256 digest over the
 *      canonical JSON of the receipt-relevant payment facts (txid, the seller
 *      output, payer/seller CAIDs, asset, amount). This commitment is what a
 *      relayer anchors so the payment maps onto a Universal Receipt Envelope (URE).
 *
 * The serializer implements real Bitcoin consensus encoding for legacy
 * (non-witness) transactions: version, varint-prefixed inputs (prevout txid +
 * index + scriptSig + sequence), varint-prefixed outputs (value + scriptPubKey),
 * and locktime. Witness data is intentionally excluded from the txid, matching
 * BIP141 (witness txids are a separate concept; the legacy txid commits to the
 * non-witness serialization).
 *
 * Self-contained: only node builtins (`node:crypto`).
 */

import { createHash } from "node:crypto";

/** A transaction input referencing a previous output. */
export interface PsbtInputLike {
  /** Previous transaction id (64 hex chars, RPC/little-endian display order). */
  prevTxid: string;
  /** Previous output index. */
  prevVout: number;
  /** scriptSig as hex (empty string for an unsigned skeleton). */
  scriptSigHex?: string;
  /** Sequence number (defaults to 0xffffffff). */
  sequence?: number;
}

/** A transaction output. */
export interface PsbtOutputLike {
  /** Value in satoshis (integer smallest-unit). */
  valueSats: number;
  /** Output locking script (scriptPubKey) as hex. */
  scriptPubKeyHex: string;
  /** Optional human address label for the receipt (not consensus data). */
  address?: string;
}

/** A PSBT-like, unsigned transaction skeleton. */
export interface PsbtLike {
  version?: number;
  inputs: PsbtInputLike[];
  outputs: PsbtOutputLike[];
  locktime?: number;
}

/** Receipt-relevant metadata that ties the BTC payment to Cred402 agents. */
export interface ReceiptMeta {
  payer_agent_id: string; // CAID
  seller_agent_id: string; // CAID
  asset: string; // "BTC"
  /** Index into `outputs` that pays the seller. */
  sellerOutputIndex: number;
}

export interface BtcReceiptCommitment {
  txid: string;
  /** `0x`-prefixed 32-byte sha256 commitment over the canonical receipt body. */
  receipt_commitment: string;
  seller_output_index: number;
  seller_value_sats: number;
  payer_agent_id: string;
  seller_agent_id: string;
  asset: string;
}

const TXID_RE = /^[0-9a-fA-F]{64}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;

function sha256(buf: Buffer): Buffer {
  return createHash("sha256").update(buf).digest();
}

function doubleSha256(buf: Buffer): Buffer {
  return sha256(sha256(buf));
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function stableStringify(value: unknown): string {
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

function assertHex(name: string, hex: string): void {
  if (!HEX_RE.test(hex)) {
    throw new Error(`${name} must be even-length hex, got: ${hex}`);
  }
}

/** Bitcoin CompactSize (varint) encoder. */
export function encodeVarint(n: number): Buffer {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`varint requires a non-negative integer, got ${n}`);
  }
  if (n < 0xfd) {
    return Buffer.from([n]);
  }
  if (n <= 0xffff) {
    const b = Buffer.allocUnsafe(3);
    b.writeUInt8(0xfd, 0);
    b.writeUInt16LE(n, 1);
    return b;
  }
  if (n <= 0xffffffff) {
    const b = Buffer.allocUnsafe(5);
    b.writeUInt8(0xfe, 0);
    b.writeUInt32LE(n, 1);
    return b;
  }
  const b = Buffer.allocUnsafe(9);
  b.writeUInt8(0xff, 0);
  b.writeBigUInt64LE(BigInt(n), 1);
  return b;
}

/** Encode an 8-byte little-endian satoshi value. */
function encodeValueSats(valueSats: number): Buffer {
  if (!Number.isInteger(valueSats) || valueSats < 0) {
    throw new Error(`output value must be a non-negative integer, got ${valueSats}`);
  }
  const b = Buffer.allocUnsafe(8);
  b.writeBigUInt64LE(BigInt(valueSats), 0);
  return b;
}

/**
 * Consensus-serialize the legacy (non-witness) transaction described by a
 * PSBT-like skeleton. The returned bytes are exactly what Bitcoin hashes (twice)
 * to produce the txid.
 */
export function serializeLegacyTx(psbt: PsbtLike): Buffer {
  if (!Array.isArray(psbt.inputs) || psbt.inputs.length === 0) {
    throw new Error("transaction requires at least one input");
  }
  if (!Array.isArray(psbt.outputs) || psbt.outputs.length === 0) {
    throw new Error("transaction requires at least one output");
  }

  const parts: Buffer[] = [];

  const version = psbt.version ?? 2;
  const versionBuf = Buffer.allocUnsafe(4);
  versionBuf.writeUInt32LE(version >>> 0, 0);
  parts.push(versionBuf);

  // Inputs.
  parts.push(encodeVarint(psbt.inputs.length));
  for (const input of psbt.inputs) {
    if (!TXID_RE.test(input.prevTxid)) {
      throw new Error(`invalid prevTxid: ${input.prevTxid}`);
    }
    if (!Number.isInteger(input.prevVout) || input.prevVout < 0) {
      throw new Error(`invalid prevVout: ${input.prevVout}`);
    }
    // prevout hash is stored internally in little-endian (reverse of RPC display).
    const prevHashLe = Buffer.from(input.prevTxid, "hex").reverse();
    parts.push(prevHashLe);

    const voutBuf = Buffer.allocUnsafe(4);
    voutBuf.writeUInt32LE(input.prevVout >>> 0, 0);
    parts.push(voutBuf);

    const scriptSigHex = input.scriptSigHex ?? "";
    assertHex("scriptSigHex", scriptSigHex);
    const scriptSig = Buffer.from(scriptSigHex, "hex");
    parts.push(encodeVarint(scriptSig.length));
    parts.push(scriptSig);

    const sequence = input.sequence ?? 0xffffffff;
    const seqBuf = Buffer.allocUnsafe(4);
    seqBuf.writeUInt32LE(sequence >>> 0, 0);
    parts.push(seqBuf);
  }

  // Outputs.
  parts.push(encodeVarint(psbt.outputs.length));
  for (const output of psbt.outputs) {
    parts.push(encodeValueSats(output.valueSats));
    assertHex("scriptPubKeyHex", output.scriptPubKeyHex);
    const spk = Buffer.from(output.scriptPubKeyHex, "hex");
    parts.push(encodeVarint(spk.length));
    parts.push(spk);
  }

  // Locktime.
  const locktime = psbt.locktime ?? 0;
  const locktimeBuf = Buffer.allocUnsafe(4);
  locktimeBuf.writeUInt32LE(locktime >>> 0, 0);
  parts.push(locktimeBuf);

  return Buffer.concat(parts);
}

/**
 * Compute the legacy txid of a PSBT-like skeleton: double-SHA256 of the consensus
 * serialization, reversed to RPC/little-endian display order, as 64 hex chars.
 */
export function computeTxid(psbt: PsbtLike): string {
  const serialized = serializeLegacyTx(psbt);
  const hash = doubleSha256(serialized);
  return Buffer.from(hash).reverse().toString("hex");
}

/**
 * Build a receipt commitment from a PSBT-like input plus the Cred402 agent
 * metadata. Validates the seller output index and produces a deterministic,
 * URE-anchorable commitment.
 */
export function buildReceiptCommitment(psbt: PsbtLike, meta: ReceiptMeta): BtcReceiptCommitment {
  if (
    !Number.isInteger(meta.sellerOutputIndex) ||
    meta.sellerOutputIndex < 0 ||
    meta.sellerOutputIndex >= psbt.outputs.length
  ) {
    throw new Error(`sellerOutputIndex ${meta.sellerOutputIndex} out of range for ${psbt.outputs.length} outputs`);
  }
  if (!meta.payer_agent_id || !meta.seller_agent_id) {
    throw new Error("payer_agent_id and seller_agent_id are required");
  }

  const txid = computeTxid(psbt);
  const sellerOutput = psbt.outputs[meta.sellerOutputIndex]!;

  const body = {
    chain: "bitcoin",
    txid,
    seller_output_index: meta.sellerOutputIndex,
    seller_value_sats: sellerOutput.valueSats,
    seller_script_pub_key: sellerOutput.scriptPubKeyHex,
    payer_agent_id: meta.payer_agent_id,
    seller_agent_id: meta.seller_agent_id,
    asset: meta.asset,
  };

  return {
    txid,
    receipt_commitment: "0x" + sha256Hex(stableStringify(body)),
    seller_output_index: meta.sellerOutputIndex,
    seller_value_sats: sellerOutput.valueSats,
    payer_agent_id: meta.payer_agent_id,
    seller_agent_id: meta.seller_agent_id,
    asset: meta.asset,
  };
}
