import { blake2b256 } from "../../lib/core/hash.js";

/**
 * Binary blake2b-256 Merkle tree (p3 proof-service §merkle).
 *
 * The relayer commits a batch of observed satellite events to a single Merkle
 * root, signs the root once, and ships each event with a compact inclusion
 * proof. The Casper-side verifier recomputes the leaf, walks the branch, and
 * checks it lands on the signed root — so anchoring an external receipt requires
 * cryptographic proof the event was in the relayed batch, not blind trust.
 */
export interface MerkleProof {
  leaf: string; // 0x blake2b256 of the leaf payload
  index: number; // original leaf position in the batch
  branch: string[]; // sibling hashes from leaf up to the root
}

const LEAF_PREFIX = "00";
const NODE_PREFIX = "01";

/** Domain-separated leaf hash (prevents second-preimage across leaf/node). */
export function leafHash(payload: string): string {
  return blake2b256(LEAF_PREFIX + payload);
}

function nodeHash(left: string, right: string): string {
  return blake2b256(NODE_PREFIX + left + right);
}

/** Build the Merkle root and per-leaf inclusion proofs for a batch of leaves. */
export function buildMerkleTree(leaves: string[]): { root: string; proofs: MerkleProof[] } {
  if (leaves.length === 0) {
    // Empty batch commits to a fixed, well-known root.
    return { root: blake2b256(LEAF_PREFIX), proofs: [] };
  }
  const hashed = leaves.map(leafHash);
  const proofs: MerkleProof[] = hashed.map((leaf, index) => ({ leaf, index, branch: [] }));
  const pos = hashed.map((_, i) => i); // each leaf's position within the current level

  let level = hashed.slice();
  while (level.length > 1) {
    for (let p = 0; p < proofs.length; p++) {
      const idx = pos[p]!;
      const sibIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
      // Odd final node has no sibling → it pairs with itself (Bitcoin-style padding).
      const sibling = sibIdx < level.length ? level[sibIdx]! : level[idx]!;
      proofs[p]!.branch.push(sibling);
      pos[p] = Math.floor(idx / 2);
    }
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]!;
      const right = i + 1 < level.length ? level[i + 1]! : left;
      next.push(nodeHash(left, right));
    }
    level = next;
  }
  return { root: level[0]!, proofs };
}

/** Recompute the root from a leaf + branch and compare to the expected root. */
export function verifyMerkleProof(proof: MerkleProof, expectedRoot: string): boolean {
  let hash = proof.leaf;
  let index = proof.index;
  for (const sibling of proof.branch) {
    // Even index → current node is the left child; odd → right child.
    hash = index % 2 === 0 ? nodeHash(hash, sibling) : nodeHash(sibling, hash);
    index = Math.floor(index / 2);
  }
  return hash === expectedRoot;
}
