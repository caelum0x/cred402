import type { Evidence } from "../../core/types.js";
import { deployHash, shortId } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "RWAEvidenceRegistry";

/**
 * RWAEvidenceRegistry — stores hashed evidence about real-world assets, each
 * linked to the x402 receipt that paid for it. Mirrors
 * `contracts/rwa_evidence_registry`.
 */
export class RWAEvidenceRegistry {
  private readonly evidence = new Map<string, Evidence>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  submit_evidence(args: {
    rwa_id: string;
    agent_id: string;
    evidence_type: string;
    evidence_hash: string;
    confidence: number;
    linked_receipt_id: string;
  }): Evidence {
    const ev: Evidence = {
      evidence_id: shortId("ev"),
      rwa_id: args.rwa_id,
      agent_id: args.agent_id,
      evidence_type: args.evidence_type,
      evidence_hash: args.evidence_hash,
      confidence: Math.max(0, Math.min(100, args.confidence)),
      timestamp: this.clock.now(),
      linked_receipt_id: args.linked_receipt_id,
      verified: false,
    };
    this.evidence.set(ev.evidence_id, ev);
    this.bus.emit("EvidenceSubmitted", CONTRACT, deployHash(), {
      evidence_id: ev.evidence_id,
      rwa_id: ev.rwa_id,
      agent_id: ev.agent_id,
      evidence_type: ev.evidence_type,
      evidence_hash: ev.evidence_hash,
      confidence: ev.confidence,
      linked_receipt_id: ev.linked_receipt_id,
    });
    return { ...ev };
  }

  verify_evidence(evidence_id: string): Evidence {
    const ev = this.must(evidence_id);
    ev.verified = true;
    this.bus.emit("EvidenceVerified", CONTRACT, deployHash(), { evidence_id, rwa_id: ev.rwa_id });
    return { ...ev };
  }

  forRwa(rwa_id: string): Evidence[] {
    return this.list().filter((e) => e.rwa_id === rwa_id);
  }

  get(evidence_id: string): Evidence | undefined {
    const e = this.evidence.get(evidence_id);
    return e ? { ...e } : undefined;
  }

  list(): Evidence[] {
    return [...this.evidence.values()].map((e) => ({ ...e }));
  }

  private must(evidence_id: string): Evidence {
    const e = this.evidence.get(evidence_id);
    if (!e) throw new Error(`unknown evidence: ${evidence_id}`);
    return e;
  }
}
