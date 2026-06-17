import type { Ledger } from "../ledger/ledger.js";

/**
 * Enterprise RealFi GA (roadmap p9).
 *
 * Turns Cred402's RealFi + credit surfaces into something an enterprise can buy and
 * operate against: named tenants, plan-based entitlements (which operations a tenant
 * may call), per-tenant quota + rate limits, and a tamper-evident audit trail that
 * can be exported for compliance/SLA reporting. This is the access-control and
 * accountability layer that sits in front of the oracle, attestation registry, and
 * data commons — the difference between a demo API and a product with customers.
 */

export type Entitlement =
  | "credit_check"
  | "bulk_underwrite"
  | "issue_attestation"
  | "data_commons"
  | "audit_export";

export interface TenantPlan {
  name: string;
  entitlements: Entitlement[];
  /** Max metered operations per 30-day period. */
  monthly_quota: number;
  /** Max operations per minute (burst protection). */
  rate_per_min: number;
}

export const PLANS: Record<string, TenantPlan> = {
  developer: {
    name: "developer",
    entitlements: ["credit_check", "data_commons"],
    monthly_quota: 1000,
    rate_per_min: 30,
  },
  growth: {
    name: "growth",
    entitlements: ["credit_check", "bulk_underwrite", "data_commons", "issue_attestation"],
    monthly_quota: 50_000,
    rate_per_min: 120,
  },
  enterprise: {
    name: "enterprise",
    entitlements: ["credit_check", "bulk_underwrite", "data_commons", "issue_attestation", "audit_export"],
    monthly_quota: 1_000_000,
    rate_per_min: 600,
  },
};

export interface Tenant {
  tenant_id: string;
  plan: string;
  entitlements: Entitlement[];
  active: boolean;
  created_at: number;
}

export interface AuditEntry {
  seq: number;
  tenant_id: string;
  operation: string;
  entitlement: Entitlement;
  allowed: boolean;
  reason?: string;
  at: number;
}

export interface AuthorizeResult {
  allowed: boolean;
  reason?: string;
  remaining_quota: number;
}

export interface TenantUsage {
  tenant_id: string;
  period_start: number;
  used: number;
  quota: number;
  remaining: number;
}

const PERIOD_SECONDS = 30 * 86400;

interface UsageState {
  period_start: number;
  count: number;
  recent: number[]; // op timestamps within the trailing rate window
}

export class EnterpriseRealFi {
  private readonly tenants = new Map<string, Tenant>();
  private readonly usage = new Map<string, UsageState>();
  private readonly audit: AuditEntry[] = [];
  private seq = 0;

  constructor(private readonly ledger: Ledger) {}

  private now(): number {
    return this.ledger.clock.now();
  }

  /** Onboard a tenant on a plan, optionally with extra ad-hoc entitlements. */
  registerTenant(input: { tenant_id: string; plan: keyof typeof PLANS | string; extra_entitlements?: Entitlement[] }): Tenant {
    if (this.tenants.has(input.tenant_id)) throw new Error(`tenant already exists: ${input.tenant_id}`);
    const plan = PLANS[input.plan];
    if (!plan) throw new Error(`unknown plan: ${input.plan}`);
    const entitlements = [...new Set([...plan.entitlements, ...(input.extra_entitlements ?? [])])];
    const tenant: Tenant = {
      tenant_id: input.tenant_id,
      plan: plan.name,
      entitlements,
      active: true,
      created_at: this.now(),
    };
    this.tenants.set(tenant.tenant_id, tenant);
    this.usage.set(tenant.tenant_id, { period_start: this.now(), count: 0, recent: [] });
    return cloneTenant(tenant);
  }

  /**
   * Authorize one metered operation for a tenant. Enforces: tenant active, the
   * entitlement is granted, the rolling-period quota is not exhausted, and the
   * per-minute rate is within limit. Every call — allowed or denied — is recorded
   * to the audit trail.
   */
  authorize(tenantId: string, entitlement: Entitlement, operation = entitlement): AuthorizeResult {
    const tenant = this.tenants.get(tenantId);
    const now = this.now();
    if (!tenant) return this.record(tenantId, operation, entitlement, false, "unknown tenant", 0);

    const plan = PLANS[tenant.plan]!;
    const u = this.usage.get(tenantId)!;
    // Roll the quota period if it has elapsed.
    if (now - u.period_start >= PERIOD_SECONDS) {
      u.period_start = now;
      u.count = 0;
      u.recent = [];
    }
    const remaining = Math.max(0, plan.monthly_quota - u.count);

    if (!tenant.active) return this.record(tenantId, operation, entitlement, false, "tenant suspended", remaining);
    if (!tenant.entitlements.includes(entitlement)) {
      return this.record(tenantId, operation, entitlement, false, `plan '${tenant.plan}' lacks entitlement '${entitlement}'`, remaining);
    }
    if (u.count >= plan.monthly_quota) {
      return this.record(tenantId, operation, entitlement, false, "monthly quota exhausted", 0);
    }
    // Per-minute rate limit.
    u.recent = u.recent.filter((t) => now - t < 60);
    if (u.recent.length >= plan.rate_per_min) {
      return this.record(tenantId, operation, entitlement, false, "rate limit exceeded", remaining);
    }

    // Charge the operation.
    u.count++;
    u.recent.push(now);
    return this.record(tenantId, operation, entitlement, true, undefined, plan.monthly_quota - u.count);
  }

  /** Authorize then run `fn` if allowed; the result is metered + audited. Throws on deny. */
  guard<T>(tenantId: string, entitlement: Entitlement, fn: () => T, operation = entitlement): T {
    const res = this.authorize(tenantId, entitlement, operation);
    if (!res.allowed) throw new Error(`forbidden: ${res.reason}`);
    return fn();
  }

  suspendTenant(tenantId: string): Tenant {
    const t = this.must(tenantId);
    t.active = false;
    return cloneTenant(t);
  }

  resumeTenant(tenantId: string): Tenant {
    const t = this.must(tenantId);
    t.active = true;
    return cloneTenant(t);
  }

  usageFor(tenantId: string): TenantUsage {
    const tenant = this.must(tenantId);
    const plan = PLANS[tenant.plan]!;
    const u = this.usage.get(tenantId)!;
    return {
      tenant_id: tenantId,
      period_start: u.period_start,
      used: u.count,
      quota: plan.monthly_quota,
      remaining: Math.max(0, plan.monthly_quota - u.count),
    };
  }

  getTenant(tenantId: string): Tenant | undefined {
    const t = this.tenants.get(tenantId);
    return t ? cloneTenant(t) : undefined;
  }

  /** Export the audit trail (optionally filtered by tenant) for compliance/SLA. */
  exportAudit(filter: { tenant_id?: string; allowed?: boolean } = {}): AuditEntry[] {
    return this.audit
      .filter((e) => (filter.tenant_id ? e.tenant_id === filter.tenant_id : true))
      .filter((e) => (filter.allowed === undefined ? true : e.allowed === filter.allowed))
      .map((e) => ({ ...e }));
  }

  private record(
    tenant_id: string,
    operation: string,
    entitlement: Entitlement,
    allowed: boolean,
    reason: string | undefined,
    remaining_quota: number,
  ): AuthorizeResult {
    this.audit.push({ seq: ++this.seq, tenant_id, operation, entitlement, allowed, reason, at: this.now() });
    return { allowed, reason, remaining_quota };
  }

  private must(tenantId: string): Tenant {
    const t = this.tenants.get(tenantId);
    if (!t) throw new Error(`unknown tenant: ${tenantId}`);
    return t;
  }
}

function cloneTenant(t: Tenant): Tenant {
  return { ...t, entitlements: [...t.entitlements] };
}
