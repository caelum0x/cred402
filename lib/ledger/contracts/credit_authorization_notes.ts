import { deployHash, blake2b256 } from "../../core/hash.js";
import {
  buildCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../crosschain/standards/credit_notes.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";
import type { GlobalExposureManager } from "./global_exposure_manager.js";

const CONTRACT = "CreditAuthorizationNotes";

export type CanStatus = "issued" | "consumed" | "revoked" | "expired";

export interface StoredCan {
  note: CreditAuthorizationNote;
  status: CanStatus;
  issued_at: number;
}

/**
 * CreditAuthorizationNotes (p3 §6) — issues short-lived, Casper-policy-signed
 * permissions that let a satellite chain open credit for an agent. Issuance
 * RESERVES global exposure first, so an agent can never be authorized beyond its
 * Casper-rooted global cap across all chains.
 */
export class CreditAuthorizationNotes {
  private readonly notes = new Map<string, StoredCan>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
    private readonly policyPrivatePem: string,
    private readonly exposure: GlobalExposureManager,
  ) {}

  issue_can(args: {
    agent_id: string;
    credit_score: number;
    risk_policy_version: number;
    target_chain: string;
    target_pool: string;
    max_draw: bigint; // asset smallest units == normalized USD micro
    asset: string;
    ttl_seconds?: number;
  }): CreditAuthorizationNote {
    // Reserve global exposure BEFORE authorizing (the multichain over-borrow guard).
    const ex = this.exposure.reserve_exposure(args.agent_id, args.max_draw);

    const nonce = blake2b256(`${args.agent_id}:${args.target_chain}:${this.clock.now()}:${this.notes.size}`);
    const note = buildCreditAuthorizationNote(
      {
        agent_id: args.agent_id,
        target_chain: args.target_chain,
        target_pool: args.target_pool,
        max_draw: args.max_draw.toString(),
        asset: args.asset,
        credit_score: args.credit_score,
        risk_policy_version: args.risk_policy_version,
        global_exposure_after_draw: (ex.outstanding + ex.reserved).toString(),
        expires_at: this.clock.now() + (args.ttl_seconds ?? 600),
        nonce,
      },
      this.policyPrivatePem,
    );
    this.notes.set(note.note_id, { note, status: "issued", issued_at: this.clock.now() });
    this.bus.emit("CreditNoteIssued", CONTRACT, deployHash(), {
      note_id: note.note_id,
      agent_id: note.agent_id,
      target_chain: note.target_chain,
      max_draw: note.max_draw,
      asset: note.asset,
    });
    return { ...note };
  }

  /** Mark a CAN consumed once the satellite vault has drawn against it. */
  consume_can(note_id: string, drawn: bigint): void {
    const s = this.must(note_id);
    if (s.status !== "issued") throw new Error(`CAN ${note_id} is ${s.status}`);
    s.status = "consumed";
    this.exposure.activate_exposure(s.note.agent_id, drawn);
    this.bus.emit("CreditNoteConsumed", CONTRACT, deployHash(), { note_id, agent_id: s.note.agent_id, drawn: drawn.toString() });
  }

  /** Revoke / expire an unused CAN and release its reservation. */
  revoke_can(note_id: string): void {
    const s = this.must(note_id);
    if (s.status !== "issued") return;
    s.status = "revoked";
    this.exposure.release_reservation(s.note.agent_id, BigInt(s.note.max_draw));
    this.bus.emit("CreditNoteRevoked", CONTRACT, deployHash(), { note_id, agent_id: s.note.agent_id });
  }

  get(note_id: string): StoredCan | undefined {
    const s = this.notes.get(note_id);
    return s ? { ...s, note: { ...s.note } } : undefined;
  }

  list(): StoredCan[] {
    return [...this.notes.values()].map((s) => ({ ...s, note: { ...s.note } }));
  }

  private must(note_id: string): StoredCan {
    const s = this.notes.get(note_id);
    if (!s) throw new Error(`unknown CAN ${note_id}`);
    return s;
  }
}
