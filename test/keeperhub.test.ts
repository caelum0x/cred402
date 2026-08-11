import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SmartGasEstimator,
  PaymentRouter,
  AuditTrail,
  KeeperHubExecutor,
} from "../lib/keeperhub/index.js";
import type {
  AuditRecord,
  ExecutionIntent,
  GasEstimate,
  PaymentReceipt,
  SimulationResult,
} from "../lib/keeperhub/index.js";

// -- fixtures ---------------------------------------------------------------

const GAS_INPUTS = { base_fee_wei: 1_000_000_000n, priority_fee_wei: 2_000_000n, gas_limit: 100_000 };

function intent(over: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return { kind: "credit_draw", chain_id: "8453", to: "0xpool", label: "cred402 draw", ...over };
}

function auditRecord(over: Partial<AuditRecord> = {}): AuditRecord {
  const simulation: SimulationResult = { ok: true, gas_estimate: 120_000, source: "sim" };
  const gas: GasEstimate = {
    max_fee_per_gas: "2002000000",
    max_priority_fee_per_gas: "2000000",
    gas_limit: 120_000,
    attempts: 1,
    strategy: "eip1559-exponential-backoff",
  };
  const payment: PaymentReceipt = { protocol: "x402", amount: "10000", asset: "USDC", network: "base" };
  return {
    audit_id: "a1",
    execution_id: "e1",
    chain_id: "8453",
    intent_kind: "credit_draw",
    label: "draw",
    trigger: {},
    simulation,
    gas,
    payment,
    private_routed: true,
    sponsored: false,
    tx_hash: "0xabc",
    status: "submitted",
    submitted_at: 1,
    ...over,
  };
}

// -- SmartGasEstimator ------------------------------------------------------

test("gas: attempt 0 is the baseline EIP-1559 estimate (no backoff bump)", () => {
  const est = new SmartGasEstimator();
  const g = est.estimate(GAS_INPUTS, 0);
  assert.equal(g.max_fee_per_gas, "2002000000"); // 2× base + priority
  assert.equal(g.max_priority_fee_per_gas, "2000000");
  assert.equal(g.gas_limit, 100_000);
  assert.equal(g.attempts, 1);
  assert.equal(g.strategy, "eip1559-exponential-backoff");
});

test("gas: exponential backoff bumps both fee components by backoffFactor each attempt", () => {
  const est = new SmartGasEstimator(); // default backoffFactor 1.25
  const a0 = est.estimate(GAS_INPUTS, 0);
  const a1 = est.estimate(GAS_INPUTS, 1);

  // priority is scaled exactly by the backoff factor.
  assert.equal(a1.max_priority_fee_per_gas, "2500000"); // 2_000_000 × 1.25
  assert.equal(BigInt(a1.max_priority_fee_per_gas), (BigInt(a0.max_priority_fee_per_gas) * 125n) / 100n);
  // the fee cap also grows and carries the extra attempt count.
  assert.equal(a1.max_fee_per_gas, "2502500000");
  assert.ok(BigInt(a1.max_fee_per_gas) > BigInt(a0.max_fee_per_gas));
  assert.equal(a1.attempts, 2);

  // monotonically increasing across further attempts.
  let prev = BigInt(a1.max_fee_per_gas);
  for (let attempt = 2; attempt < est.maxAttempts; attempt++) {
    const g = est.estimate(GAS_INPUTS, attempt);
    assert.ok(BigInt(g.max_fee_per_gas) > prev, `attempt ${attempt} fee should exceed attempt ${attempt - 1}`);
    prev = BigInt(g.max_fee_per_gas);
  }
});

test("gas: retryDelayMs grows exponentially with the attempt number", () => {
  const est = new SmartGasEstimator();
  assert.equal(est.retryDelayMs(0), 500);
  assert.equal(est.retryDelayMs(1), 625); // 500 × 1.25
  assert.ok(est.retryDelayMs(2) > est.retryDelayMs(1));
  assert.ok(est.retryDelayMs(3) > est.retryDelayMs(2));
});

test("gas: throws once maxAttempts backoff attempts are exhausted", () => {
  const est = new SmartGasEstimator({ maxAttempts: 2 });
  assert.doesNotThrow(() => est.estimate(GAS_INPUTS, 1));
  assert.throws(() => est.estimate(GAS_INPUTS, 2), /exhausted 2 backoff attempts/);
});

test("gas: rejects a backoffFactor <= 1 (would never clear a stuck tx)", () => {
  assert.throws(() => new SmartGasEstimator({ backoffFactor: 1 }), /backoffFactor must be > 1/);
  assert.throws(() => new SmartGasEstimator({ backoffFactor: 0.9 }), /backoffFactor must be > 1/);
});

// -- PaymentRouter ----------------------------------------------------------

test("payments: default rail is x402 on Base USDC", () => {
  const receipt = new PaymentRouter().settle(intent());
  assert.equal(receipt.protocol, "x402");
  assert.equal(receipt.asset, "USDC");
  assert.equal(receipt.network, "base");
  assert.equal(receipt.amount, "10000"); // default $0.01
  assert.ok(receipt.payment_proof);
});

test("payments: mppOnly forces the MPP rail on Tempo USDC.e", () => {
  const receipt = new PaymentRouter({ mppOnly: true }).settle(intent());
  assert.equal(receipt.protocol, "mpp");
  assert.equal(receipt.asset, "USDC.e");
  assert.equal(receipt.network, "tempo");
});

test("payments: sponsorship on mainnet Ethereum settles at zero cost", () => {
  const receipt = new PaymentRouter({ sponsorship: true }).settle(intent({ chain_id: "1" }));
  assert.equal(receipt.protocol, "sponsored");
  assert.equal(receipt.amount, "0");
  assert.equal(receipt.network, "ethereum");
});

test("payments: sponsorship on a non-mainnet chain still charges x402", () => {
  const receipt = new PaymentRouter({ sponsorship: true }).settle(intent({ chain_id: "114" }));
  assert.equal(receipt.protocol, "x402");
  assert.equal(receipt.amount, "10000");
  assert.equal(receipt.network, "base");
});

// -- AuditTrail -------------------------------------------------------------

test("audit: append, get, and list scoped to an agent", () => {
  const trail = new AuditTrail();
  trail.append(auditRecord({ audit_id: "a1", agent_id: "A" }));
  trail.append(auditRecord({ audit_id: "a2", agent_id: "A" }));
  trail.append(auditRecord({ audit_id: "a3", agent_id: "B" }));

  assert.equal(trail.get("a2")?.audit_id, "a2");
  assert.equal(trail.get("missing"), undefined);
  assert.equal(trail.list().length, 3);
  assert.deepEqual(trail.list("A").map((r) => r.audit_id), ["a1", "a2"]);
  assert.deepEqual(trail.list("B").map((r) => r.audit_id), ["a3"]);
});

test("audit: confirm immutably replaces the record and sets gas_used/tx_hash", () => {
  const trail = new AuditTrail();
  const original = trail.append(auditRecord({ audit_id: "a1", status: "submitted", tx_hash: "" }));

  const confirmed = trail.confirm("a1", { gas_used: 98_400, confirmed_at: 1234, tx_hash: "0xfeed" });
  assert.ok(confirmed);
  assert.equal(confirmed!.status, "confirmed");
  assert.equal(confirmed!.gas_used, 98_400);
  assert.equal(confirmed!.tx_hash, "0xfeed");
  assert.equal(confirmed!.confirmed_at, 1234);

  // the previously-returned record object was NOT mutated in place (append-only).
  assert.equal(original.status, "submitted");
  assert.equal(original.tx_hash, "");

  // and the stored record reflects the confirmation.
  assert.equal(trail.get("a1")?.status, "confirmed");
  assert.equal(trail.get("a1")?.gas_used, 98_400);

  assert.equal(trail.confirm("nope", { confirmed_at: 1 }), undefined);
});

test("audit: fail marks a reverted execution failed, not confirmed", () => {
  const trail = new AuditTrail();
  trail.append(auditRecord({ audit_id: "a1", status: "submitted" }));

  const failed = trail.fail("a1", { confirmed_at: 42, detail: "execution reverted" });
  assert.ok(failed);
  assert.equal(failed!.status, "failed");
  assert.equal(failed!.detail, "execution reverted");
  // a reverted execution must NOT count as confirmed in the reliability summary.
  assert.equal(trail.get("a1")?.status, "failed");
  assert.equal(trail.summary().confirmed, 0);
  assert.equal(trail.summary().failed, 1);
});

test("audit: summary counts confirmed / private / sponsored and averages backoff", () => {
  const trail = new AuditTrail();
  trail.append(auditRecord({ audit_id: "a1", private_routed: true, sponsored: false, gas: { ...auditRecord().gas, attempts: 1 }, payment: { protocol: "x402", amount: "10000", asset: "USDC", network: "base" } }));
  trail.append(auditRecord({ audit_id: "a2", private_routed: true, sponsored: false, gas: { ...auditRecord().gas, attempts: 3 }, payment: { protocol: "mpp", amount: "10000", asset: "USDC.e", network: "tempo" } }));
  trail.append(auditRecord({ audit_id: "a3", private_routed: false, sponsored: true, gas: { ...auditRecord().gas, attempts: 1 }, payment: { protocol: "sponsored", amount: "0", asset: "ETH", network: "ethereum" } }));
  trail.confirm("a1", { gas_used: 100_000, confirmed_at: 5 });

  const s = trail.summary();
  assert.equal(s.total, 3);
  assert.equal(s.confirmed, 1);
  assert.equal(s.private_routed, 2);
  assert.equal(s.sponsored, 1);
  assert.equal(s.total_gas_used, 100_000);
  assert.equal(s.avg_backoff_attempts, 1.67); // (1 + 3 + 1) / 3
  assert.deepEqual(s.by_protocol, { x402: 1, mpp: 1, sponsored: 1 });
});

// -- KeeperHubExecutor (sim path, no key) -----------------------------------

function simExecutor(over: Partial<ConstructorParameters<typeof KeeperHubExecutor>[0]> = {}) {
  return new KeeperHubExecutor({ now: () => 1_700_000_000_000, sleep: async () => {}, ...over });
}

test("executor: is not live without a KEEPERHUB_API_KEY", () => {
  assert.equal(simExecutor().isLive(), false);
});

test("executor: sim path confirms the execution and records a full audit entry", async () => {
  const exec = simExecutor();
  const result = await exec.execute(intent());

  assert.equal(result.ok, true);
  assert.equal(result.source, "sim");
  assert.ok(result.tx_hash.length > 0);
  assert.equal(result.private_routed, true); // default MEV-protected routing
  assert.equal(result.simulation.source, "sim");
  assert.equal(result.gas.attempts, 1);

  // the audit trail grew and the mirrored record is confirmed with the same tx hash.
  const trail = exec.auditTrail();
  assert.equal(trail.length, 1);
  assert.equal(trail[0]!.status, "confirmed");
  assert.equal(trail[0]!.tx_hash, result.tx_hash);
  assert.equal(trail[0]!.audit_id, result.audit_id);
  assert.ok((trail[0]!.gas_used ?? 0) > 0);
});

test("executor: reliability() reflects each executed intent", async () => {
  const exec = simExecutor();
  await exec.execute(intent({ agent_id: "A" }));
  await exec.execute(intent({ agent_id: "A" }));

  const rel = exec.reliability();
  assert.equal(rel.total, 2);
  assert.equal(rel.confirmed, 2);
  assert.equal(rel.private_routed, 2);
  assert.deepEqual(rel.by_protocol, { x402: 2 });
  assert.equal(exec.auditTrail().length, 2);
});
