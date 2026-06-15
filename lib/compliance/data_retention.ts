/**
 * Data retention policy (p2 §7.9).
 *
 * Declares how long each class of record is retained and whether it may contain
 * PII. Cred402's on-chain commitments are deliberately PII-free (p6) — this
 * policy governs the OFF-chain stores (journal, logs, compliance evidence) so an
 * operator can implement deletion/retention obligations against a single source.
 */

export type DataClass =
  | "onchain_commitment"
  | "event_journal"
  | "access_log"
  | "compliance_evidence"
  | "webhook_delivery";

export interface RetentionRule {
  dataClass: DataClass;
  retentionDays: number; // 0 = retain indefinitely (immutable ledger)
  containsPii: boolean;
  notes: string;
}

export const DEFAULT_RETENTION: RetentionRule[] = [
  { dataClass: "onchain_commitment", retentionDays: 0, containsPii: false, notes: "hashes only; immutable" },
  { dataClass: "event_journal", retentionDays: 2555, containsPii: false, notes: "7y financial-record retention" },
  { dataClass: "access_log", retentionDays: 365, containsPii: true, notes: "IP/key-id; rotate yearly" },
  { dataClass: "compliance_evidence", retentionDays: 2555, containsPii: true, notes: "KYB/sanctions evidence; encrypted at rest" },
  { dataClass: "webhook_delivery", retentionDays: 90, containsPii: false, notes: "delivery attempts for debugging" },
];

export class DataRetentionPolicy {
  constructor(private readonly rules: RetentionRule[] = DEFAULT_RETENTION) {}

  rule(dataClass: DataClass): RetentionRule {
    const r = this.rules.find((x) => x.dataClass === dataClass);
    if (!r) throw new Error(`no retention rule for ${dataClass}`);
    return r;
  }

  /** Is a record of `dataClass` created at `createdAt` past its retention window? */
  isExpired(dataClass: DataClass, createdAt: number, now: number): boolean {
    const r = this.rule(dataClass);
    if (r.retentionDays === 0) return false;
    return now - createdAt > r.retentionDays * 24 * 60 * 60 * 1000;
  }

  all(): RetentionRule[] {
    return this.rules.map((r) => ({ ...r }));
  }
}
