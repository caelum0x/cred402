import { blake2b256 } from "../core/hash.js";

/**
 * Receipt proofs (roadmap p8 — trust-ladder Stage 4).
 *
 * Lets an agent prove a payment receipt is valid and anchored on-chain WITHOUT
 * revealing the receipt itself: a counterparty can verify "this agent finalized an
 * x402 receipt in category `rwa` for ≥ X" while the amount, counterparty, and
 * other fields stay hidden.
 *
 * This is the dependency-free, Casper-verifiable primitive for that: a per-field
 * commitment scheme (each attribute is hidden behind a secret-salted hash) plus a
 * Merkle tree whose root is the on-chain anchor. A disclosure proof reveals the
 * (value, salt) of only the chosen fields, ships the opaque commitments of the
 * rest, and a Merkle path to the published root. The verifier recomputes the leaf
 * and checks inclusion — learning the disclosed fields and nothing else.
 *
 * NOTE: this is a *commitment-based* zero-knowledge-style proof (selective
 * disclosure + membership), not a zk-SNARK. It hides undisclosed fields and proves
 * membership cheaply on-chain; full circuit-based ZK (hiding even the membership
 * witness) is a later hardening, but this is the honest Stage-4 building block.
 */

export type ReceiptAttributes = Record<string, string>;

export interface ReceiptCommitment {
  receipt_id: string;
  /** Per-field hiding commitments (key → H(key=value|salt)). */
  commitments: Record<string, string>;
  /** The Merkle leaf binding all field commitments together. */
  leaf: string;
}

export interface MerkleStep {
  sibling: string;
  /** True if `sibling` is the left node (current hash is the right). */
  left: boolean;
}

export interface DisclosureProof {
  root: string;
  receipt_id: string;
  /** Fields the prover chose to reveal, with their opening salts. */
  disclosed: Record<string, { value: string; salt: string }>;
  /** Commitments for the fields kept hidden. */
  hidden_commitments: Record<string, string>;
  merkle_path: MerkleStep[];
  leaf_index: number;
}

export interface VerifyResult {
  valid: boolean;
  /** The revealed field values (only those disclosed). */
  disclosed: Record<string, string>;
  reason?: string;
}

function fieldCommitment(key: string, value: string, salt: string): string {
  return blake2b256(`${key}=${value}|${salt}`);
}

function leafFromCommitments(commitments: Record<string, string>): string {
  const joined = Object.keys(commitments)
    .sort()
    .map((k) => `${k}:${commitments[k]}`)
    .join("|");
  return blake2b256(`leaf|${joined}`);
}

function hashPair(a: string, b: string): string {
  return blake2b256(`node|${a}|${b}`);
}

/** Build a Merkle root over leaf hashes (duplicate the last leaf on odd levels). */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return blake2b256("empty");
  let level = [...leaves];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left; // duplicate odd tail
      next.push(hashPair(left, right));
    }
    level = next;
  }
  return level[0]!;
}

/** Build the inclusion path (sibling hashes) for a leaf index. */
export function merklePath(leaves: string[], index: number): MerkleStep[] {
  if (index < 0 || index >= leaves.length) throw new Error("leaf index out of range");
  const path: MerkleStep[] = [];
  let level = [...leaves];
  let idx = index;
  while (level.length > 1) {
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;
    const sibling = siblingIdx < level.length ? level[siblingIdx]! : level[idx]!; // odd tail dup
    path.push({ sibling, left: isRight });
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(hashPair(left, right));
    }
    level = next;
    idx = Math.floor(idx / 2);
  }
  return path;
}

/** Recompute a root from a leaf + path; the inclusion check. */
export function rootFromPath(leaf: string, path: MerkleStep[]): string {
  let h = leaf;
  for (const step of path) {
    h = step.left ? hashPair(step.sibling, h) : hashPair(h, step.sibling);
  }
  return h;
}

export class ReceiptProofSystem {
  /** A prover secret used to derive per-field salts; never leaves the prover. */
  constructor(private readonly secret: string) {
    if (!secret) throw new Error("ReceiptProofSystem requires a non-empty prover secret");
  }

  /** Deterministic, high-entropy salt per (receipt, field) — hiding without RNG. */
  private salt(receiptId: string, key: string): string {
    return blake2b256(`${this.secret}|${receiptId}|${key}`);
  }

  /** Commit a single receipt's attributes into a field-wise commitment + leaf. */
  commit(receiptId: string, attrs: ReceiptAttributes): ReceiptCommitment {
    const commitments: Record<string, string> = {};
    for (const [key, value] of Object.entries(attrs)) {
      commitments[key] = fieldCommitment(key, value, this.salt(receiptId, key));
    }
    return { receipt_id: receiptId, commitments, leaf: leafFromCommitments(commitments) };
  }

  /** Anchor a batch of receipts: returns the Merkle root + ordered commitments. */
  publishRoot(receipts: Array<{ receipt_id: string; attrs: ReceiptAttributes }>): {
    root: string;
    commitments: ReceiptCommitment[];
  } {
    const commitments = receipts.map((r) => this.commit(r.receipt_id, r.attrs));
    return { root: merkleRoot(commitments.map((c) => c.leaf)), commitments };
  }

  /**
   * Produce a selective-disclosure proof for one receipt: reveal only `disclose`
   * fields, hide the rest, and include a Merkle path to the published root.
   */
  prove(
    receipts: Array<{ receipt_id: string; attrs: ReceiptAttributes }>,
    index: number,
    disclose: string[],
  ): DisclosureProof {
    if (index < 0 || index >= receipts.length) throw new Error("receipt index out of range");
    const commitments = receipts.map((r) => this.commit(r.receipt_id, r.attrs));
    const leaves = commitments.map((c) => c.leaf);
    const target = receipts[index]!;
    const targetCommit = commitments[index]!;

    const discloseSet = new Set(disclose);
    for (const k of discloseSet) {
      if (!(k in target.attrs)) throw new Error(`cannot disclose unknown field: ${k}`);
    }

    const disclosed: Record<string, { value: string; salt: string }> = {};
    const hidden_commitments: Record<string, string> = {};
    for (const key of Object.keys(target.attrs)) {
      if (discloseSet.has(key)) {
        disclosed[key] = { value: target.attrs[key]!, salt: this.salt(target.receipt_id, key) };
      } else {
        hidden_commitments[key] = targetCommit.commitments[key]!;
      }
    }

    return {
      root: merkleRoot(leaves),
      receipt_id: target.receipt_id,
      disclosed,
      hidden_commitments,
      merkle_path: merklePath(leaves, index),
      leaf_index: index,
    };
  }

  /**
   * Verify a disclosure proof against an expected root. Recomputes the disclosed
   * field commitments from their openings, rebuilds the leaf with the hidden
   * commitments, and checks Merkle inclusion. No prover secret needed — anyone can
   * verify. Returns the disclosed values (and nothing about hidden fields).
   */
  static verify(proof: DisclosureProof, expectedRoot: string): VerifyResult {
    const disclosedValues: Record<string, string> = {};
    const commitments: Record<string, string> = { ...proof.hidden_commitments };
    for (const [key, opening] of Object.entries(proof.disclosed)) {
      commitments[key] = fieldCommitment(key, opening.value, opening.salt);
      disclosedValues[key] = opening.value;
    }
    const leaf = leafFromCommitments(commitments);
    const recomputedRoot = rootFromPath(leaf, proof.merkle_path);
    if (recomputedRoot !== proof.root) {
      return { valid: false, disclosed: disclosedValues, reason: "leaf does not reconstruct the proof root" };
    }
    if (proof.root !== expectedRoot) {
      return { valid: false, disclosed: disclosedValues, reason: "proof root does not match the anchored root" };
    }
    return { valid: true, disclosed: disclosedValues };
  }
}
