import type { Ledger } from "../ledger/ledger.js";

/**
 * Agent attestation graph — a web of trust where established agents vouch for
 * others. An attestation from a high-reputation agent gives a small, capped
 * reputation boost (anti-Sybil: low-rep agents can't vouch, and each
 * attester→target pair counts once). The directed graph is queryable, so credit
 * and discovery can factor in who an agent's vouchers are.
 */

export interface Attestation {
  from: string;
  to: string;
  weight: number; // reputation boost applied (points)
  note: string;
  at: number;
}

const MIN_ATTESTER_REPUTATION = 60;
const MAX_BOOST_PER_TARGET = 6; // total reputation an agent can gain from vouches

export class AttestationGraph {
  private readonly edges: Attestation[] = [];
  private readonly seen = new Set<string>(); // `${from}->${to}`
  private readonly boostByTarget = new Map<string, number>();

  constructor(private readonly ledger: Ledger) {}

  attest(from: string, to: string, note = ""): Attestation {
    if (from === to) throw new Error("an agent cannot attest itself");
    const attester = this.ledger.agents.get(from);
    const target = this.ledger.agents.get(to);
    if (!attester) throw new Error("attester is not a registered agent");
    if (!target) throw new Error("target is not a registered agent");
    if (attester.reputation_score < MIN_ATTESTER_REPUTATION) {
      throw new Error(`attester needs reputation >= ${MIN_ATTESTER_REPUTATION} (has ${attester.reputation_score})`);
    }
    const key = `${from}->${to}`;
    if (this.seen.has(key)) throw new Error("already attested this agent");
    this.seen.add(key);

    // Boost scales with attester reputation, capped per target (anti-gaming).
    const already = this.boostByTarget.get(to) ?? 0;
    const proposed = Math.round((attester.reputation_score - MIN_ATTESTER_REPUTATION) / 10) + 1;
    const weight = Math.max(0, Math.min(proposed, MAX_BOOST_PER_TARGET - already));
    if (weight > 0) {
      this.boostByTarget.set(to, already + weight);
      this.ledger.agents.update_reputation(to, weight, "0xattest", "PEER_ATTESTATION");
    }
    const edge: Attestation = { from, to, weight, note, at: this.ledger.clock.now() };
    this.edges.push(edge);
    return edge;
  }

  forAgent(agentId: string): { received: Attestation[]; given: Attestation[]; trust_score: number } {
    const received = this.edges.filter((e) => e.to === agentId);
    const given = this.edges.filter((e) => e.from === agentId);
    // Trust score: distinct vouchers weighted by their boost.
    const trust_score = received.reduce((s, e) => s + e.weight, 0);
    return { received, given, trust_score };
  }

  list(): Attestation[] {
    return [...this.edges];
  }

  /**
   * The full web-of-trust graph: every agent that has given or received a vouch,
   * with its in/out degree and accumulated trust score, plus the directed edges.
   * Drives the console's trust-graph visualization and discovery ranking.
   */
  graph(): {
    nodes: { agent_id: string; in_degree: number; out_degree: number; trust_score: number; reputation: number }[];
    edges: Attestation[];
    total_attestations: number;
  } {
    const ids = new Set<string>();
    for (const e of this.edges) {
      ids.add(e.from);
      ids.add(e.to);
    }
    const nodes = [...ids]
      .map((id) => {
        const { received, given, trust_score } = this.forAgent(id);
        return {
          agent_id: id,
          in_degree: received.length,
          out_degree: given.length,
          trust_score,
          reputation: this.ledger.agents.get(id)?.reputation_score ?? 0,
        };
      })
      .sort((a, b) => b.trust_score - a.trust_score || b.in_degree - a.in_degree);
    return { nodes, edges: [...this.edges], total_attestations: this.edges.length };
  }
}
