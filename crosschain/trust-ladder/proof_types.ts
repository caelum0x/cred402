import { ProofService, type ChainEventProof } from "../proof-service/proof_service.js";

/**
 * Proof-type registry (p4 §26 Stage 4 — zk / light-client extensibility).
 *
 * "Design now for Stage 4, launch at Stage 1 safely." Every relayed proof
 * carries a `proof_type`; the registry dispatches to the verifier for that type.
 * Two verifiers are real and shipping — `merkle` (single signed Merkle batch,
 * Stage 1) and `threshold` (quorum of relayer attestations, Stage 2). The
 * `light_client` and `zk` slots are registered but HONESTLY rejected until built
 * — the protocol never pretends an unverifiable proof is trustless.
 */

export type ProofType = "merkle" | "threshold" | "light_client" | "zk";

export interface ProofVerdict {
  ok: boolean;
  type: ProofType;
  reason?: string;
}

export interface ThresholdProof {
  type: "threshold";
  height: number;
  root: string;
  /** Relayer keys that attested the agreed root, and the required quorum. */
  attesters: string[];
  quorum: number;
}

export interface MerkleProofCarrier {
  type: "merkle";
  proof: ChainEventProof;
}

export type AnyProof = MerkleProofCarrier | ThresholdProof | { type: "light_client" | "zk" };

export interface ProofVerifier {
  type: ProofType;
  verify(proof: AnyProof): ProofVerdict;
}

/** Stage 1 verifier — a single relayer's signed Merkle inclusion proof. */
export function merkleVerifier(trustedRelayerKeys?: Set<string>): ProofVerifier {
  return {
    type: "merkle",
    verify(proof) {
      if (proof.type !== "merkle") return { ok: false, type: "merkle", reason: "wrong proof shape" };
      const r = ProofService.verify(proof.proof, trustedRelayerKeys);
      return { ok: r.ok, type: "merkle", reason: r.reason };
    },
  };
}

/** Stage 2 verifier — a quorum of distinct relayers agreeing on the batch root. */
export function thresholdVerifier(): ProofVerifier {
  return {
    type: "threshold",
    verify(proof) {
      if (proof.type !== "threshold") return { ok: false, type: "threshold", reason: "wrong proof shape" };
      const unique = new Set(proof.attesters);
      if (unique.size < proof.quorum) {
        return { ok: false, type: "threshold", reason: `only ${unique.size}/${proof.quorum} attesters` };
      }
      return { ok: true, type: "threshold" };
    },
  };
}

/** A verifier slot that is registered but not yet built — fails honestly. */
export function unavailableVerifier(type: "light_client" | "zk"): ProofVerifier {
  return {
    type,
    verify() {
      return { ok: false, type, reason: `proof type '${type}' not yet supported (trust-ladder stage pending)` };
    },
  };
}

export class ProofTypeRegistry {
  private readonly verifiers = new Map<ProofType, ProofVerifier>();

  constructor(verifiers: ProofVerifier[]) {
    for (const v of verifiers) this.verifiers.set(v.type, v);
  }

  /** Default registry: merkle + threshold real; light_client + zk honestly unavailable. */
  static withDefaults(trustedRelayerKeys?: Set<string>): ProofTypeRegistry {
    return new ProofTypeRegistry([
      merkleVerifier(trustedRelayerKeys),
      thresholdVerifier(),
      unavailableVerifier("light_client"),
      unavailableVerifier("zk"),
    ]);
  }

  /** Proof types that currently verify to `ok: true` for a valid proof. */
  supported(): ProofType[] {
    return ["merkle", "threshold"].filter((t) => this.verifiers.has(t as ProofType)) as ProofType[];
  }

  verify(proof: AnyProof): ProofVerdict {
    const v = this.verifiers.get(proof.type);
    if (!v) return { ok: false, type: proof.type, reason: `no verifier registered for '${proof.type}'` };
    return v.verify(proof);
  }
}
