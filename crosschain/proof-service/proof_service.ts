import { blake2b256, stableStringify } from "../../lib/core/hash.js";
import { generateAgentKeypair, sign, verifyCasperHex, type AgentKeypair } from "../../lib/x402/keys.js";
import { buildMerkleTree, verifyMerkleProof, leafHash, type MerkleProof } from "./merkle.js";

/**
 * ProofService (p3 crosschain/proof-service).
 *
 * Turns raw satellite-chain events into verifiable, Casper-anchorable proofs.
 * A relayer batches the events it observed, the ProofService commits them to a
 * blake2b Merkle root and signs that root once with its relayer key, then emits
 * one {@link ChainEventProof} per event carrying a Merkle inclusion branch. Any
 * party (the Casper root relayer, an auditor) can verify a proof with no shared
 * state beyond the relayer's public key.
 */

export interface ChainEventRecord {
  origin_chain: string;
  event_type: string;
  /** Block height / sequence the event was finalized at on the origin chain. */
  observed_at: number;
  /** Canonical, repl-stable event payload (e.g. a Universal Receipt Envelope). */
  payload: Record<string, unknown>;
}

export interface ChainEventProof {
  type: "Cred402ProofEnvelope";
  version: "1";
  origin_chain: string;
  event_type: string;
  observed_at: number;
  payload: Record<string, unknown>;
  payload_hash: string; // blake2b256(canonical_json(payload))
  batch_root: string; // Merkle root over the relayed batch
  merkle: MerkleProof; // inclusion proof of this event in the batch
  relayer_key: string; // Casper-style "01"+hex ed25519 public key of the relayer
  root_signature: string; // relayer signature over `${origin_chain}|${batch_root}`
}

export interface CommittedBatch {
  root: string;
  signature: string;
  proofs: ChainEventProof[];
}

function leafPayload(e: ChainEventRecord): string {
  // The Merkle leaf binds chain + type + finality height + payload so a proof
  // cannot be replayed under a different event type or chain.
  return stableStringify({ c: e.origin_chain, t: e.event_type, o: e.observed_at, p: e.payload });
}

export class ProofService {
  readonly relayerKey: string;
  private readonly keys: AgentKeypair;

  constructor(keys: AgentKeypair = generateAgentKeypair()) {
    this.keys = keys;
    this.relayerKey = keys.publicKeyHex;
  }

  /** Commit a batch of observed events to a signed Merkle root + per-event proofs. */
  commitBatch(events: ChainEventRecord[]): CommittedBatch {
    const leaves = events.map(leafPayload);
    const { root, proofs } = buildMerkleTree(leaves);
    // Each event shares one origin chain in a relayer batch; guard the invariant.
    const chains = new Set(events.map((e) => e.origin_chain));
    if (chains.size > 1) throw new Error("a relayer batch must cover a single origin chain");
    const originChain = events[0]?.origin_chain ?? "unknown";
    const signature = sign(this.keys.privatePem, `${originChain}|${root}`);

    const out: ChainEventProof[] = events.map((e, i) => ({
      type: "Cred402ProofEnvelope",
      version: "1",
      origin_chain: e.origin_chain,
      event_type: e.event_type,
      observed_at: e.observed_at,
      payload: e.payload,
      payload_hash: blake2b256(stableStringify(e.payload)),
      batch_root: root,
      merkle: proofs[i]!,
      relayer_key: this.relayerKey,
      root_signature: signature,
    }));
    return { root, signature, proofs: out };
  }

  /** Verify a single proof end to end: leaf integrity, Merkle inclusion, signature. */
  static verify(proof: ChainEventProof, trustedRelayerKeys?: Set<string>): { ok: boolean; reason?: string } {
    if (proof.type !== "Cred402ProofEnvelope") return { ok: false, reason: "wrong type" };
    if (trustedRelayerKeys && !trustedRelayerKeys.has(proof.relayer_key)) {
      return { ok: false, reason: "untrusted relayer key" };
    }
    if (blake2b256(stableStringify(proof.payload)) !== proof.payload_hash) {
      return { ok: false, reason: "payload_hash mismatch" };
    }
    const expectedLeaf = leafHash(
      stableStringify({ c: proof.origin_chain, t: proof.event_type, o: proof.observed_at, p: proof.payload }),
    );
    if (proof.merkle.leaf !== expectedLeaf) return { ok: false, reason: "leaf mismatch" };
    if (!verifyMerkleProof(proof.merkle, proof.batch_root)) return { ok: false, reason: "merkle inclusion failed" };
    if (!verifyCasperHex(proof.relayer_key, `${proof.origin_chain}|${proof.batch_root}`, proof.root_signature)) {
      return { ok: false, reason: "root signature invalid" };
    }
    return { ok: true };
  }
}
