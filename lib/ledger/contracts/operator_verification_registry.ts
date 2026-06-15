import { deployHash } from "../../core/hash.js";
import {
  verifyOperatorVerification,
  type OperatorVerificationEnvelope,
  type VerificationLevel,
  type VerificationStatus,
} from "../../realfi/envelopes.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "OperatorVerificationRegistry";

export interface OperatorVerification {
  operator_id: string;
  provider: string;
  verification_level: VerificationLevel;
  jurisdiction: string;
  status: VerificationStatus;
  attestation_hash: string;
  verified_at: number;
  expires_at: number;
  revoked_at?: number;
}

/**
 * OperatorVerificationRegistry (p6) — links a real-world business/operator to an
 * agent via a Stripe-Identity-style attestation, on-chain as hashes only. A
 * verified operator strengthens credit underwriting (anonymous agent → low cap;
 * verified operator + repayment history → much higher cap), but never replaces
 * Casper-native receipt history.
 */
export class OperatorVerificationRegistry {
  private readonly verifications = new Map<string, OperatorVerification>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  record_operator_verification(ove: OperatorVerificationEnvelope, attestation_hash: string): OperatorVerification {
    const check = verifyOperatorVerification(ove, this.clock.now());
    if (!check.ok) throw new Error(`operator verification rejected: ${check.reason}`);
    const record: OperatorVerification = {
      operator_id: ove.operator_id,
      provider: ove.provider,
      verification_level: ove.verification_level,
      jurisdiction: ove.jurisdiction,
      status: ove.verification_status,
      attestation_hash,
      verified_at: ove.verified_at,
      expires_at: ove.expires_at,
    };
    this.verifications.set(ove.operator_id, record);
    this.bus.emit("OperatorVerified", CONTRACT, deployHash(), {
      operator_id: ove.operator_id,
      provider: ove.provider,
      verification_level: ove.verification_level,
      jurisdiction: ove.jurisdiction,
    });
    return { ...record };
  }

  revoke_operator_verification(operator_id: string, reason_hash: string): void {
    const v = this.verifications.get(operator_id);
    if (!v || v.revoked_at) return;
    v.revoked_at = this.clock.now();
    v.status = "revoked";
    this.bus.emit("OperatorVerificationRevoked", CONTRACT, deployHash(), { operator_id, reason_hash });
  }

  get_operator_verification(operator_id: string): OperatorVerification | undefined {
    const v = this.verifications.get(operator_id);
    return v ? { ...v } : undefined;
  }

  /** Is the operator currently verified (not expired, not revoked)? */
  is_verified(operator_id: string): boolean {
    const v = this.verifications.get(operator_id);
    return !!v && !v.revoked_at && v.status === "verified" && v.expires_at > this.clock.now();
  }

  list(): OperatorVerification[] {
    return [...this.verifications.values()].map((v) => ({ ...v }));
  }
}
