import { test } from "node:test";
import assert from "node:assert/strict";
import { ApiKeyStore } from "../lib/gateway/api_keys.js";
import { RateLimiter } from "../lib/gateway/rate_limit.js";
import { Gateway } from "../lib/gateway/index.js";
import { UnauthorizedError, ForbiddenError, RateLimitError } from "../lib/gateway/errors.js";
import type { GatewayConfig } from "../lib/gateway/config.js";
import { ServerState } from "../api/state.js";

/**
 * The paying-customer flow (p2 §7.1): mint a scoped API key → make an
 * authenticated, scoped request → get metered by the per-key quota. Plus the
 * non-negotiable honesty invariant for a CREDIT product: an unknown agent is
 * never given a fabricated score, and seeded demo data is always labelled.
 *
 * These are money/access-control paths, so they are pinned with deterministic
 * clocks (no wall-clock flake) and cover the reject branches, not just the
 * happy path.
 */

function testConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    env: "testnet",
    port: 4021,
    logLevel: "error",
    dataDir: "",
    authRequired: true,
    adminApiKey: "seed-admin",
    rateLimit: { windowMs: 60_000, maxRequests: 3 },
    casper: { nodeAddress: "https://node.testnet.casper.network", chainName: "casper-test" },
    webhooks: { maxRetries: 5 },
    ...overrides,
  };
}

// ── Key issuance ──────────────────────────────────────────────────────────

test("key issuance: the secret is shown once, only its hash is stored", () => {
  const store = new ApiKeyStore();
  const issued = store.issue("acme-prod", ["read", "write"]);

  assert.match(issued.secret, /^c402_k_[0-9a-f]{12}_/, "secret is namespaced + carries its public id");
  assert.deepEqual(issued.scopes, ["read", "write"]);

  // The stored metadata must never leak the hash (or the secret).
  const listed = store.list();
  assert.equal(listed.length, 1);
  const record = listed[0]!;
  assert.equal(record.id, issued.id);
  assert.equal((record as Record<string, unknown>).hash, undefined, "hash is never returned in metadata");
  assert.equal((record as Record<string, unknown>).secret, undefined, "secret is never persisted");
});

test("scoped request: only the exact issued secret verifies", () => {
  const store = new ApiKeyStore();
  const issued = store.issue("reader", ["read"]);

  const ok = store.verify(issued.secret);
  assert.ok(ok, "the real secret verifies");
  assert.equal(ok!.id, issued.id);
  assert.ok(ok!.last_used_at !== undefined, "verify stamps last_used_at for observability");

  assert.equal(store.verify(undefined), undefined, "no secret → no record");
  assert.equal(store.verify("garbage"), undefined, "malformed secret is rejected before any lookup");
  assert.equal(store.verify(issued.secret + "x"), undefined, "a tampered secret fails the constant-time compare");
  // A well-formed secret for an id that does not exist must not match.
  assert.equal(store.verify(`c402_k_0123456789ab_${"A".repeat(32)}`), undefined);
});

test("scoped request: a revoked key stops verifying immediately", () => {
  const store = new ApiKeyStore();
  const issued = store.issue("compromised", ["read", "write"]);
  assert.ok(store.verify(issued.secret));

  assert.equal(store.revoke(issued.id), true, "first revoke succeeds");
  assert.equal(store.revoke(issued.id), false, "double-revoke is a no-op");
  assert.equal(store.verify(issued.secret), undefined, "a revoked secret no longer authenticates");
});

test("scoped request: hasScope enforces least privilege, admin is a superset", () => {
  const store = new ApiKeyStore();
  const reader = store.verify(store.issue("r", ["read"]).secret)!;
  const admin = store.verify(store.issue("a", ["admin"]).secret)!;

  assert.equal(store.hasScope(reader, "read"), true);
  assert.equal(store.hasScope(reader, "write"), false, "a read key cannot write");
  assert.equal(store.hasScope(reader, "admin"), false);
  assert.equal(store.hasScope(admin, "read"), true, "admin implies read");
  assert.equal(store.hasScope(admin, "write"), true, "admin implies write");
  assert.equal(store.hasScope(admin, "admin"), true);
});

// ── Quota / billing behaviour ───────────────────────────────────────────────

test("quota: a per-identity token bucket allows the burst then meters", () => {
  let now = 1_000_000;
  const rl = new RateLimiter(3, 60_000, () => now);

  assert.deepEqual(
    [rl.check("key:a").allowed, rl.check("key:a").allowed, rl.check("key:a").allowed],
    [true, true, true],
    "the full burst capacity is admitted",
  );
  const blocked = rl.check("key:a");
  assert.equal(blocked.allowed, false, "the 4th request in-window is metered");
  assert.equal(blocked.remaining, 0);
  assert.ok(blocked.retryAfterMs > 0, "a metered caller is told when to retry");

  // A different identity has its own independent bucket (no cross-tenant leakage).
  assert.equal(rl.check("key:b").allowed, true, "a second key is unaffected by the first's quota");
});

test("quota: the bucket refills over the window and retryAfterMs is honest", () => {
  let now = 0;
  const rl = new RateLimiter(2, 1000, () => now); // 1 token per 500ms
  assert.equal(rl.check("x").allowed, true);
  assert.equal(rl.check("x").allowed, true);

  const denied = rl.check("x");
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 500, "one token costs half the window to refill");

  // Wait exactly the advertised retry — the request now succeeds.
  now += denied.retryAfterMs;
  assert.equal(rl.check("x").allowed, true, "the caller is admitted after honoring Retry-After");
});

// ── Full authenticate → meter flow via the Gateway ──────────────────────────

test("flow: prod gateway requires a valid, correctly-scoped key then meters it", () => {
  const gw = new Gateway(testConfig({ rateLimit: { windowMs: 60_000, maxRequests: 2 } }));
  const writer = gw.apiKeys.issue("bot", ["read", "write"]);

  // No key → 401.
  assert.throws(() => gw.authenticate(undefined, "1.2.3.4", "read"), UnauthorizedError);
  // Valid key but insufficient scope → 403.
  const reader = gw.apiKeys.issue("ro", ["read"]);
  assert.throws(() => gw.authenticate(reader.secret, "1.2.3.4", "write"), ForbiddenError);

  // Valid + scoped → auth context keyed by the key id (not the IP).
  const auth = gw.authenticate(writer.secret, "1.2.3.4", "write");
  assert.equal(auth.identity, `key:${writer.id}`);
  assert.equal(auth.key?.id, writer.id);

  // The quota is charged against the key identity, then trips 429.
  assert.doesNotThrow(() => gw.enforceRateLimit(auth.identity));
  assert.doesNotThrow(() => gw.enforceRateLimit(auth.identity));
  assert.throws(() => gw.enforceRateLimit(auth.identity), RateLimitError);
});

test("flow: dev gateway (auth off) meters by client IP, not by key", () => {
  const gw = new Gateway(testConfig({ authRequired: false, adminApiKey: undefined }));
  const auth = gw.authenticate(undefined, "9.9.9.9", "admin");
  assert.equal(auth.identity, "ip:9.9.9.9", "dev mode falls back to per-IP metering");
  assert.equal(auth.key, undefined);
});

// ── Zero-data honesty (a credit product must never fabricate) ────────────────

test("honesty: an unknown agent gets an error, never a fabricated score", () => {
  const s = new ServerState();
  const report = s.x402CreditScore("caid:casper:not-a-real-agent");
  assert.ok("error" in report, "no score is invented for an agent with no record");
  assert.match((report as { error: string }).error, /unknown agent/);
});

test("honesty: a real (non-demo) agent is labelled observed_receipts", () => {
  const s = new ServerState();
  s.ledger.agents.register_agent({
    agent_id: "caid:casper:real-1",
    owner_public_key: "01",
    agent_public_key: "01",
    service_type: "risk_scoring" as never,
  });
  const report = s.x402CreditScore("caid:casper:real-1");
  assert.ok(!("error" in report));
  if ("error" in report) return;

  assert.equal(report.demo, false, "a freshly registered agent is not demo data");
  assert.equal(report.data_source, "observed_receipts");
  assert.equal(report.x402_revenue.data_source, "observed_receipts");
  assert.equal(report.x402_revenue.receipt_count, 0, "zero receipts are reported as zero, not inflated");
  assert.doesNotMatch(report.provenance.disclaimer, /SEEDED DEMO/, "a real agent is not mislabelled as demo");
});

test("honesty: seeded demo data is always disclosed as demo", () => {
  const s = new ServerState();
  const report = s.x402CreditScore(s.economy.seller.agent_id);
  assert.ok(!("error" in report));
  if ("error" in report) return;
  assert.equal(report.demo, true, "the bootstrap seller is seeded demo data");
  assert.equal(report.data_source, "seeded_demo");
  assert.match(report.provenance.disclaimer, /SEEDED DEMO/);
});
