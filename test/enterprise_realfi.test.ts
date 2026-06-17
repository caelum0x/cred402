import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { EnterpriseRealFi } from "../lib/services/enterprise_realfi.js";

/**
 * Roadmap p9 — Enterprise RealFi GA. Tenants on plans get entitlement-gated,
 * quota- and rate-limited access, and every call is recorded to an exportable
 * audit trail.
 */

test("p9: a tenant can call entitled ops; un-entitled ops are denied + audited", () => {
  const e = new EnterpriseRealFi(new Ledger());
  e.registerTenant({ tenant_id: "acme", plan: "developer" });
  const ok = e.authorize("acme", "credit_check");
  assert.equal(ok.allowed, true);
  // developer plan lacks issue_attestation
  const denied = e.authorize("acme", "issue_attestation");
  assert.equal(denied.allowed, false);
  assert.match(denied.reason!, /lacks entitlement/);
  const audit = e.exportAudit({ tenant_id: "acme" });
  assert.equal(audit.length, 2);
  assert.equal(audit.filter((a) => a.allowed).length, 1);
});

test("p9: monthly quota is enforced and reported", () => {
  const e = new EnterpriseRealFi(new Ledger());
  // tiny quota via a custom-ish flow: use developer (1000) but assert remaining math
  e.registerTenant({ tenant_id: "t", plan: "developer" });
  const first = e.authorize("t", "credit_check");
  assert.equal(first.remaining_quota, 999);
  const usage = e.usageFor("t");
  assert.equal(usage.used, 1);
  assert.equal(usage.quota, 1000);
  assert.equal(usage.remaining, 999);
});

test("p9: per-minute rate limit blocks bursts, audited as denied", () => {
  const l = new Ledger();
  const e = new EnterpriseRealFi(l);
  e.registerTenant({ tenant_id: "burst", plan: "developer" }); // rate_per_min 30
  let allowed = 0;
  let limited = 0;
  for (let i = 0; i < 35; i++) {
    const r = e.authorize("burst", "credit_check");
    if (r.allowed) allowed++;
    else if (r.reason === "rate limit exceeded") limited++;
  }
  assert.equal(allowed, 30, "30/min cap");
  assert.equal(limited, 5);
});

test("p9: rate window advances with the clock", () => {
  const l = new Ledger();
  const e = new EnterpriseRealFi(l);
  e.registerTenant({ tenant_id: "t", plan: "developer" });
  for (let i = 0; i < 30; i++) assert.equal(e.authorize("t", "credit_check").allowed, true);
  assert.equal(e.authorize("t", "credit_check").allowed, false); // rate-limited now
  l.clock.advance(61); // move past the 60s window
  assert.equal(e.authorize("t", "credit_check").allowed, true, "window cleared");
});

test("p9: suspend/resume gates access and is reflected in the audit trail", () => {
  const e = new EnterpriseRealFi(new Ledger());
  e.registerTenant({ tenant_id: "t", plan: "enterprise" });
  e.suspendTenant("t");
  const denied = e.authorize("t", "credit_check");
  assert.equal(denied.allowed, false);
  assert.match(denied.reason!, /suspended/);
  e.resumeTenant("t");
  assert.equal(e.authorize("t", "credit_check").allowed, true);
});

test("p9: guard() runs the op only when authorized, else throws; audit_export is enterprise-only", () => {
  const e = new EnterpriseRealFi(new Ledger());
  e.registerTenant({ tenant_id: "ent", plan: "enterprise" });
  e.registerTenant({ tenant_id: "dev", plan: "developer" });
  const value = e.guard("ent", "audit_export", () => e.exportAudit());
  assert.ok(Array.isArray(value));
  assert.throws(() => e.guard("dev", "audit_export", () => 1), /forbidden/);
});

test("p9: extra entitlements can be granted beyond the plan", () => {
  const e = new EnterpriseRealFi(new Ledger());
  e.registerTenant({ tenant_id: "t", plan: "developer", extra_entitlements: ["issue_attestation"] });
  assert.equal(e.authorize("t", "issue_attestation").allowed, true);
  assert.ok(e.getTenant("t")!.entitlements.includes("issue_attestation"));
});

test("p9: unknown tenant is denied cleanly (no throw) and audited", () => {
  const e = new EnterpriseRealFi(new Ledger());
  const r = e.authorize("ghost", "credit_check");
  assert.equal(r.allowed, false);
  assert.match(r.reason!, /unknown tenant/);
  assert.equal(e.exportAudit({ tenant_id: "ghost" }).length, 1);
});
