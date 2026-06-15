import { deployHash } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "RealFiAttestationRegistry";

/** Generic off-chain finance evidence kinds (p6). */
export type AttestationType =
  | "bank_verification"
  | "cashflow_report"
  | "payout_confirmation"
  | "chargeback_signal"
  | "sanctions_clearance"
  | "accounting_audit";

export type AttestationStatus = "active" | "expired" | "revoked";

export interface RealFiAttestation {
  attestation_id: string;
  attestation_type: AttestationType;
  subject_id: string; // operator_id or agent CAID
  provider: string;
  attestation_hash: string;
  status: AttestationStatus;
  created_at: number;
  expires_at: number;
  revoked_at?: number;
}

/**
 * RealFiAttestationRegistry (p6) — a generic registry for any off-chain finance
 * evidence (Plaid bank verification, payout confirmations, chargeback signals,
 * sanctions clearance, accounting audits). Everything is a hash + status +
 * provider; the underwriting layer reads these as ADDITIONAL signals, never as a
 * replacement for Casper-native receipts.
 */
export class RealFiAttestationRegistry {
  private readonly attestations = new Map<string, RealFiAttestation>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  record_attestation(input: {
    attestation_id: string;
    attestation_type: AttestationType;
    subject_id: string;
    provider: string;
    attestation_hash: string;
    expires_at: number;
  }): RealFiAttestation {
    if (this.attestations.has(input.attestation_id)) throw new Error("attestation already recorded");
    if (input.expires_at <= this.clock.now()) throw new Error("attestation already expired");
    const record: RealFiAttestation = {
      attestation_id: input.attestation_id,
      attestation_type: input.attestation_type,
      subject_id: input.subject_id,
      provider: input.provider,
      attestation_hash: input.attestation_hash,
      status: "active",
      created_at: this.clock.now(),
      expires_at: input.expires_at,
    };
    this.attestations.set(input.attestation_id, record);
    this.bus.emit("RealFiAttestationRecorded", CONTRACT, deployHash(), {
      attestation_id: input.attestation_id,
      attestation_type: input.attestation_type,
      subject_id: input.subject_id,
      provider: input.provider,
    });
    return { ...record };
  }

  revoke_attestation(attestation_id: string, reason_hash: string): void {
    const a = this.attestations.get(attestation_id);
    if (!a || a.revoked_at) return;
    a.revoked_at = this.clock.now();
    a.status = "revoked";
    this.bus.emit("RealFiAttestationRevoked", CONTRACT, deployHash(), { attestation_id, reason_hash });
  }

  get_attestation(attestation_id: string): RealFiAttestation | undefined {
    const a = this.attestations.get(attestation_id);
    if (!a) return undefined;
    return { ...this.materialize(a) };
  }

  /** Active (non-expired, non-revoked) attestations for a subject, optionally by type. */
  forSubject(subject_id: string, type?: AttestationType): RealFiAttestation[] {
    return this.list().filter(
      (a) => a.subject_id === subject_id && a.status === "active" && (!type || a.attestation_type === type),
    );
  }

  list(): RealFiAttestation[] {
    return [...this.attestations.values()].map((a) => this.materialize(a));
  }

  /** Reflect expiry lazily at read time without mutating stored history. */
  private materialize(a: RealFiAttestation): RealFiAttestation {
    if (a.status === "active" && a.expires_at <= this.clock.now()) return { ...a, status: "expired" };
    return { ...a };
  }
}
