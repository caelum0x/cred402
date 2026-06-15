/**
 * Cred402 Bitcoin adapter — Inscription Anchor Parser.
 *
 * Bitcoin can anchor a Cred402 evidence or receipt hash as an Ordinals-style
 * inscription. The inscription envelope is embedded in a taproot witness script:
 *
 *     OP_FALSE OP_IF
 *       OP_PUSH "ord"
 *       OP_PUSH 0x01  OP_PUSH <content-type bytes>     (tag 1 = content type)
 *       OP_PUSH 0x05  OP_PUSH <metadata bytes>         (tag 5 = metadata, optional)
 *       OP_0                                            (body separator)
 *       OP_PUSH <body chunk> ...                        (body, concatenated)
 *     OP_ENDIF
 *
 * For a Cred402 anchor, the inscription body is the canonical anchor JSON:
 *
 *     { "v": "cred402-anchor/1",
 *       "kind": "evidence" | "receipt",
 *       "hash": "0x<64 hex>",          // the anchored evidence_hash or receipt_id
 *       "uaid"?: "uaid:...",            // when kind == "evidence"
 *       "agent_id"?: "cred402:casper:..." }
 *
 * This module parses the raw witness-script hex, walks the script push opcodes,
 * extracts the inscription content type + body, and validates the Cred402 anchor
 * shape. It is read-only and treats Bitcoin strictly as an evidence reference.
 *
 * Self-contained: only node builtins (`node:crypto`).
 */

import { createHash } from "node:crypto";

const OP_0 = 0x00;
const OP_FALSE = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_IF = 0x63;
const OP_ENDIF = 0x68;
const OP_1 = 0x51;
const OP_16 = 0x60;

const ORD_MAGIC = "ord";
const TAG_CONTENT_TYPE = 0x01;
const TAG_METADATA = 0x05;
const BODY_SEPARATOR = OP_0;

const HASH_RE = /^0x[0-9a-f]{64}$/;
const ANCHOR_VERSION = "cred402-anchor/1";

export type AnchorKind = "evidence" | "receipt";

export interface Cred402Anchor {
  version: typeof ANCHOR_VERSION;
  kind: AnchorKind;
  /** `0x`-prefixed 32-byte hex: the anchored evidence_hash or receipt_id. */
  hash: string;
  uaid: string | null;
  agent_id: string | null;
}

export interface ParsedInscription {
  contentType: string | null;
  /** Raw inscription body bytes. */
  body: Buffer;
  /** Body decoded as UTF-8 (for JSON anchors). */
  bodyText: string;
}

/** A single decoded script element: an opcode marker or a data push. */
interface ScriptToken {
  opcode: number;
  data: Buffer | null;
}

function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Tokenize a Bitcoin script (hex) into opcodes and data pushes. Supports direct
 * pushes (0x01..0x4b) and OP_PUSHDATA1/2/4. Non-push opcodes are emitted with
 * `data: null`.
 */
export function tokenizeScript(scriptHex: string): ScriptToken[] {
  if (typeof scriptHex !== "string" || !/^(?:[0-9a-fA-F]{2})*$/.test(scriptHex)) {
    throw new Error("script must be even-length hex");
  }
  const script = Buffer.from(scriptHex, "hex");
  const tokens: ScriptToken[] = [];
  let i = 0;

  while (i < script.length) {
    const opcode = script[i]!;
    i += 1;

    if (opcode >= 0x01 && opcode <= 0x4b) {
      const len = opcode;
      if (i + len > script.length) {
        throw new Error("truncated direct push");
      }
      tokens.push({ opcode, data: script.subarray(i, i + len) });
      i += len;
    } else if (opcode === OP_PUSHDATA1) {
      if (i + 1 > script.length) {
        throw new Error("truncated OP_PUSHDATA1 length");
      }
      const len = script[i]!;
      i += 1;
      if (i + len > script.length) {
        throw new Error("truncated OP_PUSHDATA1 data");
      }
      tokens.push({ opcode, data: script.subarray(i, i + len) });
      i += len;
    } else if (opcode === OP_PUSHDATA2) {
      if (i + 2 > script.length) {
        throw new Error("truncated OP_PUSHDATA2 length");
      }
      const len = script.readUInt16LE(i);
      i += 2;
      if (i + len > script.length) {
        throw new Error("truncated OP_PUSHDATA2 data");
      }
      tokens.push({ opcode, data: script.subarray(i, i + len) });
      i += len;
    } else if (opcode === OP_PUSHDATA4) {
      if (i + 4 > script.length) {
        throw new Error("truncated OP_PUSHDATA4 length");
      }
      const len = script.readUInt32LE(i);
      i += 4;
      if (i + len > script.length) {
        throw new Error("truncated OP_PUSHDATA4 data");
      }
      tokens.push({ opcode, data: script.subarray(i, i + len) });
      i += len;
    } else {
      tokens.push({ opcode, data: null });
    }
  }

  return tokens;
}

/** True when a token is a data push carrying the given small-int tag byte. */
function isTagPush(token: ScriptToken, tag: number): boolean {
  return token.data !== null && token.data.length === 1 && token.data[0] === tag;
}

/**
 * Extract the inscription content-type and body from a witness script that
 * contains an `OP_FALSE OP_IF "ord" ... OP_ENDIF` envelope. Returns null if no
 * Ordinals envelope is present.
 */
export function parseInscription(scriptHex: string): ParsedInscription | null {
  const tokens = tokenizeScript(scriptHex);

  // Find the envelope start: OP_FALSE, OP_IF, push "ord".
  let start = -1;
  for (let i = 0; i + 2 < tokens.length; i++) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    const c = tokens[i + 2]!;
    const aIsFalse = a.opcode === OP_FALSE && a.data === null;
    const bIsIf = b.opcode === OP_IF;
    const cIsOrd = c.data !== null && c.data.toString("latin1") === ORD_MAGIC;
    if (aIsFalse && bIsIf && cIsOrd) {
      start = i + 3;
      break;
    }
  }
  if (start === -1) {
    return null;
  }

  let contentType: string | null = null;
  const bodyChunks: Buffer[] = [];
  let inBody = false;
  let i = start;

  while (i < tokens.length) {
    const token = tokens[i]!;

    if (token.opcode === OP_ENDIF) {
      break;
    }

    if (!inBody) {
      if (isTagPush(token, TAG_CONTENT_TYPE) && i + 1 < tokens.length) {
        const value = tokens[i + 1]!;
        if (value.data !== null) {
          contentType = value.data.toString("utf8");
        }
        i += 2;
        continue;
      }
      if (isTagPush(token, TAG_METADATA) && i + 1 < tokens.length) {
        // metadata present but not needed for the anchor; skip its value.
        i += 2;
        continue;
      }
      if (token.opcode === BODY_SEPARATOR && token.data === null) {
        inBody = true;
        i += 1;
        continue;
      }
      // Unknown tag with a value — skip the pair defensively.
      i += 1;
      continue;
    }

    // In body: concatenate every data push until OP_ENDIF.
    if (token.data !== null) {
      bodyChunks.push(token.data);
    }
    i += 1;
  }

  const body = Buffer.concat(bodyChunks);
  return { contentType, body, bodyText: body.toString("utf8") };
}

/**
 * Parse a Cred402 anchor from an inscription witness script. Validates the anchor
 * envelope and the hash shape. Throws a descriptive error on malformed input.
 */
export function parseAnchorScript(scriptHex: string): Cred402Anchor {
  const inscription = parseInscription(scriptHex);
  if (inscription === null) {
    throw new Error("no Ordinals inscription envelope found in script");
  }
  return parseAnchorBody(inscription.bodyText);
}

/** Parse and validate a Cred402 anchor from an inscription body JSON string. */
export function parseAnchorBody(bodyText: string): Cred402Anchor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error("inscription body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("inscription body must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.v !== ANCHOR_VERSION) {
    throw new Error(`unsupported anchor version: ${String(obj.v)}`);
  }
  if (obj.kind !== "evidence" && obj.kind !== "receipt") {
    throw new Error(`invalid anchor kind: ${String(obj.kind)}`);
  }
  if (typeof obj.hash !== "string" || !HASH_RE.test(obj.hash)) {
    throw new Error(`anchor hash must be a 0x-prefixed 32-byte hex digest, got ${String(obj.hash)}`);
  }
  const kind = obj.kind as AnchorKind;

  const uaid = typeof obj.uaid === "string" ? obj.uaid : null;
  const agent_id = typeof obj.agent_id === "string" ? obj.agent_id : null;

  if (kind === "evidence" && uaid !== null && !/^uaid:[a-z0-9_-]+:[0-9a-f]{64}$/.test(uaid)) {
    throw new Error(`invalid uaid in evidence anchor: ${uaid}`);
  }

  return { version: ANCHOR_VERSION, kind, hash: obj.hash, uaid, agent_id };
}

/**
 * Verify that an anchored hash matches an independently-known evidence/receipt
 * hash. Returns true iff they are byte-equal (case-insensitive hex).
 */
export function anchorMatchesHash(anchor: Cred402Anchor, expectedHash: string): boolean {
  return anchor.hash.toLowerCase() === expectedHash.toLowerCase();
}

/**
 * Build a canonical Cred402 inscription body string for a given anchor. Useful for
 * relayers that need to produce the exact bytes to inscribe. The content commitment
 * (sha256 of the body) is returned so callers can cross-check on parse.
 */
export function buildAnchorBody(anchor: Omit<Cred402Anchor, "version">): {
  body: string;
  content_commitment: string;
} {
  if (!HASH_RE.test(anchor.hash)) {
    throw new Error(`anchor hash must be a 0x-prefixed 32-byte hex digest, got ${anchor.hash}`);
  }
  const full: Record<string, unknown> = { v: ANCHOR_VERSION, kind: anchor.kind, hash: anchor.hash };
  if (anchor.uaid !== null) {
    full.uaid = anchor.uaid;
  }
  if (anchor.agent_id !== null) {
    full.agent_id = anchor.agent_id;
  }
  const body = JSON.stringify(full);
  return { body, content_commitment: "0x" + sha256Hex(body) };
}
