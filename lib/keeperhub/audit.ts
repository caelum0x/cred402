import type { AuditRecord } from "./types.js";

/**
 * AuditTrail — KeeperHub logs every action (trigger, simulation result, submitted
 * transaction, gas used, outcome, timestamp). Cred402 keeps its own local mirror so
 * the console and the `/v1/keeperhub/audit` endpoint can show the exact reliability
 * story for each credit execution, whether it ran through the real KeeperHub API or
 * the deterministic sim.
 *
 * Append-only: entries are never mutated in place; `confirm` writes a NEW record.
 */
export class AuditTrail {
  private readonly records: AuditRecord[] = [];

  append(record: AuditRecord): AuditRecord {
    this.records.push(record);
    return record;
  }

  /** Mark a submitted execution confirmed — replaces the record immutably. */
  confirm(audit_id: string, patch: { gas_used?: number; confirmed_at: number; tx_hash?: string }): AuditRecord | undefined {
    const idx = this.records.findIndex((r) => r.audit_id === audit_id);
    if (idx < 0) return undefined;
    const prev = this.records[idx]!;
    const next: AuditRecord = {
      ...prev,
      status: "confirmed",
      gas_used: patch.gas_used ?? prev.gas_used,
      tx_hash: patch.tx_hash ?? prev.tx_hash,
      confirmed_at: patch.confirmed_at,
    };
    this.records.splice(idx, 1, next);
    return next;
  }

  /** Mark a submitted execution failed/reverted — replaces the record immutably. */
  fail(audit_id: string, patch: { confirmed_at: number; detail?: string }): AuditRecord | undefined {
    const idx = this.records.findIndex((r) => r.audit_id === audit_id);
    if (idx < 0) return undefined;
    const prev = this.records[idx]!;
    const next: AuditRecord = { ...prev, status: "failed", detail: patch.detail ?? prev.detail, confirmed_at: patch.confirmed_at };
    this.records.splice(idx, 1, next);
    return next;
  }

  get(audit_id: string): AuditRecord | undefined {
    return this.records.find((r) => r.audit_id === audit_id);
  }

  /** All records, newest last. Pass an agent id to scope to one agent. */
  list(agentId?: string): AuditRecord[] {
    const all = agentId ? this.records.filter((r) => r.agent_id === agentId) : this.records;
    return [...all];
  }

  /** Reliability summary the console shows: totals, gas, backoff, protection rates. */
  summary(): {
    total: number;
    confirmed: number;
    failed: number;
    private_routed: number;
    sponsored: number;
    avg_backoff_attempts: number;
    total_gas_used: number;
    by_protocol: Record<string, number>;
  } {
    const total = this.records.length;
    const confirmed = this.records.filter((r) => r.status === "confirmed").length;
    const failed = this.records.filter((r) => r.status === "failed").length;
    const private_routed = this.records.filter((r) => r.private_routed).length;
    const sponsored = this.records.filter((r) => r.sponsored).length;
    const attempts = this.records.reduce((s, r) => s + r.gas.attempts, 0);
    const total_gas_used = this.records.reduce((s, r) => s + (r.gas_used ?? 0), 0);
    const by_protocol: Record<string, number> = {};
    for (const r of this.records) by_protocol[r.payment.protocol] = (by_protocol[r.payment.protocol] ?? 0) + 1;
    return {
      total,
      confirmed,
      failed,
      private_routed,
      sponsored,
      avg_backoff_attempts: total ? Number((attempts / total).toFixed(2)) : 0,
      total_gas_used,
      by_protocol,
    };
  }
}
