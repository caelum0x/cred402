import { generateAgentKeypair, sign, verifyCasperHex, type AgentKeypair } from "../../lib/x402/keys.js";

/**
 * Multi-relayer optimistic coordinator (p4 §26 Stage 2).
 *
 * Stage 1 trusts a single relayer. Stage 2 has several bonded relayers each
 * attest the batch root for a height. A root is accepted once a quorum agrees;
 * during the challenge window, any relayer that attested a DIFFERENT root for
 * the same height is provably lying and gets its bond slashed. This makes a
 * single dishonest relayer unable to forge an anchor — it would be outvoted and
 * slashed. Honest fraud-proofs, no trusted single party.
 */

export interface RelayerInfo {
  key: string; // Casper-style "01"+hex public key
  bond: bigint; // slashable stake
  slashed: bigint; // total bond slashed
  active: boolean;
}

export interface Attestation {
  relayer_key: string;
  height: number;
  root: string;
  signature: string; // over `${chain}|${height}|${root}`
}

export type FinalizeStatus = "pending" | "finalized" | "no_quorum";

export interface HeightStatus {
  height: number;
  status: FinalizeStatus;
  agreed_root?: string;
  attesters: string[]; // relayer keys that attested the agreed root
  challengers: string[]; // relayer keys slashed for attesting a different root
}

export class Relayer {
  readonly keys: AgentKeypair;
  constructor(keys: AgentKeypair = generateAgentKeypair()) {
    this.keys = keys;
  }
  get key(): string {
    return this.keys.publicKeyHex;
  }
  attest(chain: string, height: number, root: string): Attestation {
    return { relayer_key: this.key, height, root, signature: sign(this.keys.privatePem, `${chain}|${height}|${root}`) };
  }
}

export class MultiRelayerCoordinator {
  private readonly relayers = new Map<string, RelayerInfo>();
  private readonly attestations = new Map<number, Attestation[]>();
  private readonly finalized = new Map<number, HeightStatus>();

  constructor(
    private readonly chain: string,
    /** Minimum agreeing relayers to finalize a root. */
    private readonly quorum = 2,
    /** Challenge window in seconds before a height can finalize. */
    private readonly challengeWindowSeconds = 60,
  ) {}

  registerRelayer(keys: AgentKeypair, bond: bigint): Relayer {
    if (bond <= 0n) throw new Error("relayer bond must be positive");
    const relayer = new Relayer(keys);
    this.relayers.set(relayer.key, { key: relayer.key, bond, slashed: 0n, active: true });
    return relayer;
  }

  relayer(key: string): RelayerInfo | undefined {
    return this.relayers.get(key);
  }

  /** Record a relayer's attestation for a height. Signature + membership verified. */
  submit(att: Attestation): void {
    const info = this.relayers.get(att.relayer_key);
    if (!info || !info.active) throw new Error("unknown or inactive relayer");
    if (!verifyCasperHex(att.relayer_key, `${this.chain}|${att.height}|${att.root}`, att.signature)) {
      throw new Error("invalid relayer signature");
    }
    if (this.finalized.has(att.height)) throw new Error(`height ${att.height} already finalized`);
    const list = this.attestations.get(att.height) ?? [];
    // A relayer cannot attest the same height twice (equivocation across calls is caught at finalize).
    if (list.some((a) => a.relayer_key === att.relayer_key)) throw new Error("relayer already attested this height");
    list.push(att);
    this.attestations.set(att.height, list);
  }

  /**
   * Finalize a height after the challenge window: pick the root with a quorum of
   * attestations; slash every relayer that attested a different root.
   */
  finalize(height: number, openedAt: number, now: number): HeightStatus {
    const existing = this.finalized.get(height);
    if (existing) return existing;
    if (now - openedAt < this.challengeWindowSeconds) {
      throw new Error(`challenge window open for height ${height}`);
    }
    const list = this.attestations.get(height) ?? [];
    const byRoot = new Map<string, string[]>();
    for (const a of list) {
      const arr = byRoot.get(a.root) ?? [];
      arr.push(a.relayer_key);
      byRoot.set(a.root, arr);
    }
    // Winning root = the one with the most attestations (must meet quorum).
    let agreed: string | undefined;
    let best: string[] = [];
    for (const [root, keys] of byRoot) {
      if (keys.length > best.length) {
        best = keys;
        agreed = root;
      }
    }
    if (!agreed || best.length < this.quorum) {
      const status: HeightStatus = { height, status: "no_quorum", attesters: [], challengers: [] };
      this.finalized.set(height, status);
      return status;
    }
    // Slash relayers who signed any other root for this height (provable equivocation).
    const challengers: string[] = [];
    for (const a of list) {
      if (a.root !== agreed) {
        const info = this.relayers.get(a.relayer_key);
        if (info) {
          info.slashed += info.bond;
          info.bond = 0n;
          info.active = false;
          challengers.push(a.relayer_key);
        }
      }
    }
    const status: HeightStatus = { height, status: "finalized", agreed_root: agreed, attesters: best, challengers };
    this.finalized.set(height, status);
    return status;
  }

  status(height: number): HeightStatus | undefined {
    return this.finalized.get(height);
  }
}
