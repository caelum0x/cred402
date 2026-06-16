import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { cspr } from "../lib/core/units.js";
import { TOOL_INDEX } from "../mcp/tools.js";
import { FraudService } from "../lib/services/fraud_service.js";

test("x402 replay protection: nonce + proof cannot be reused, expired proof rejected", () => {
  const l = new Ledger();
  const base = {
    payer_agent: "Buyer",
    seller_agent: "Seller",
    service_type: "solar_output_verification" as const,
    amount: cspr("0.002"),
    rwa_reference_hash: "0xr",
    result_hash: "0xres",
    payment_proof_hash: "0xproof-1",
    nonce: "nonce-1",
    expires_at: l.clock.now() + 300,
  };
  l.receipts.record_receipt(base); // first use ok
  // same nonce for same payer -> replay
  assert.throws(() => l.receipts.record_receipt({ ...base, payment_proof_hash: "0xproof-2" }), /nonce replay/);
  // same proof hash -> replay
  assert.throws(() => l.receipts.record_receipt({ ...base, nonce: "nonce-2" }), /proof replay/);
  // expired proof -> rejected
  assert.throws(
    () => l.receipts.record_receipt({ ...base, nonce: "nonce-3", payment_proof_hash: "0xproof-3", expires_at: l.clock.now() - 10 }),
    /expired/,
  );
});

test("FraudService: detects a reciprocal collusion ring and blocks credit", () => {
  const l = new Ledger();
  const reg = (id: string, op: string) => {
    l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
    l.passports.set_profile(id, { operator: op });
  };
  reg("A", "ring-op");
  reg("B", "ring-op"); // same operator => linkage

  // A and B wash-trade x402 receipts back and forth.
  let n = 0;
  const pay = (payer: string, seller: string) =>
    l.receipts.record_receipt({
      payer_agent: payer,
      seller_agent: seller,
      service_type: "solar_output_verification",
      amount: cspr(1),
      rwa_reference_hash: "0xr",
      result_hash: `0x${n}`,
      payment_proof_hash: `0xp${n}`,
      nonce: `n${n++}`,
      expires_at: l.clock.now() + 300,
    });
  for (let i = 0; i < 5; i++) {
    pay("A", "B");
    pay("B", "A");
  }

  const report = new FraudService(l).analyze("A");
  assert.ok(report.score >= 70, `expected high fraud score, got ${report.score}`);
  assert.ok(report.flags.some((f) => f.code === "reciprocal_loop"));
  assert.ok(report.flags.some((f) => f.code === "operator_linkage"));

  // Underwriting must refuse a high-fraud agent.
  const econ = new Cred402Economy(l);
  l.agents.seed_profile("A", { reputation_score: 80 });
  assert.throws(() => econ.credit.underwrite("A"), /fraud risk too high/);
});

test("FraudService: flags a Sybil operator swarm and off-market receipt pricing", () => {
  const l = new Ledger();
  const reg = (id: string, op: string) => {
    l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
    l.passports.set_profile(id, { operator: op });
  };
  // p4 §13 Attack 2: one operator controls three agents => Sybil swarm.
  reg("S1", "swarm-op");
  reg("S2", "swarm-op");
  reg("S3", "swarm-op");
  reg("buyer", "buyer-op");

  const swarm = new FraudService(l).analyze("S1");
  assert.equal(swarm.operator_swarm_size, 3);
  assert.ok(swarm.flags.some((f) => f.code === "sybil_operator_swarm"));

  // p4 §13 Attack 1: build a price band for weather_risk, then an off-market receipt.
  let n = 0;
  const pay = (payer: string, seller: string, amount: bigint) =>
    l.receipts.record_receipt({
      payer_agent: payer,
      seller_agent: seller,
      service_type: "weather_risk",
      amount,
      rwa_reference_hash: "0xr",
      result_hash: `0x${n}`,
      payment_proof_hash: `0xbp${n}`,
      nonce: `bn${n++}`,
      expires_at: l.clock.now() + 300,
    });
  pay("buyer", "S2", cspr(1));
  pay("buyer", "S2", cspr(1));
  pay("buyer", "S3", cspr(1));
  pay("buyer", "S3", cspr(1));
  pay("buyer", "S1", cspr(100)); // ~100x the median => off-band

  const priced = new FraudService(l).analyze("S1");
  assert.ok(priced.flags.some((f) => f.code === "pricing_band_anomaly"), "expected off-market pricing flag");
});

test("RWAAssetRegistry: registers an asset and emits an event", () => {
  const l = new Ledger();
  l.assets.register_asset({
    rwa_id: "SOLAR-A17",
    asset_type: "solar_receivable",
    issuer: "SPV-A17",
    jurisdiction_code: "TR",
    metadata_hash: "0xabc",
    document_bundle_hash: "0xdef",
  });
  assert.equal(l.assets.get("SOLAR-A17")?.status, "active");
  assert.ok(l.bus.all().some((e) => e.name === "RwaAssetRegistered"));
});

test("DisputeCourt + SlashingVault: verdict distributes the slash", () => {
  const l = new Ledger();
  const d = l.disputes.open({
    dispute_type: "bad_evidence",
    complainant: "Watchdog",
    respondent_agent: "Seller",
    note: "fake",
    evidence_hash: "0x1",
  });
  assert.equal(l.disputes.openCount("Seller"), 1);
  l.disputes.issue_verdict(d.dispute_id, "agent_loses", cspr(10), ["falsified"]);
  const rec = l.slashing.apply_slash({ agent_id: "Seller", amount: cspr(10), reason: "x", dispute_id: d.dispute_id });
  const total =
    rec.distribution.victim_reimbursement +
    rec.distribution.insurance_reserve +
    rec.distribution.protocol_treasury +
    rec.distribution.burn;
  assert.equal(total, cspr(10), "distribution must reconcile to the slashed amount");
  assert.equal(l.slashing.totalSlashed(), cspr(10));
});

test("Governance: pausing credit draws blocks a draw", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.underwriteSeller();
  econ.ledger.governance.pause("credit_draws");
  assert.throws(() => econ.drawCredit(5), /paused/);
});

test("Governance: min reputation gate blocks underwriting", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "Weak", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.agents.update_reputation("Weak", -50, "0x0"); // 70 -> 20, below the 40 minimum
  const econ = new Cred402Economy(l);
  // CreditAgent.underwrite must refuse a sub-threshold agent.
  assert.throws(() => econ.credit.underwrite("Weak"), /below governance minimum/);
});

test("ReputationEngine: composite score stays within 0..100", () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  const agent = econ.ledger.agents.get(econ.seller.agent_id)!;
  const { score } = econ.ledger.reputation.compute(agent, { open_disputes: 0, repayments_on_time: 2, repayments_total: 2 });
  assert.ok(score >= 0 && score <= 100);
});

test("AgentPassport: aggregates profile + risk flags", () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  const p = econ.ledger.buildPassport(econ.seller.agent_id)!;
  assert.equal(p.agent_id, econ.seller.agent_id);
  assert.ok(p.capabilities.includes("x402.sell"));
  assert.equal(p.stake, cspr(50));
});

test("MCP tools: registry exposes 44 tools and they dispatch", () => {
  assert.equal(TOOL_INDEX.size, 44);
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const passport = TOOL_INDEX.get("cred402.get_agent_passport")!.handler({ agent_id: econ.seller.agent_id }, econ) as { agent_id: string };
  assert.equal(passport.agent_id, econ.seller.agent_id);
  const policy = TOOL_INDEX.get("cred402.get_risk_policy")!.handler({}, econ) as { policy_version: string };
  assert.equal(policy.policy_version, "v1");
  // the new bureau tools dispatch and return structured data
  const discovery = TOOL_INDEX.get("cred402.discover_agents")!.handler({ limit: 5 }, econ) as { results: unknown[] };
  assert.ok(Array.isArray(discovery.results));
  const portfolio = TOOL_INDEX.get("cred402.portfolio_report")!.handler({}, econ) as { hhi: number };
  assert.equal(typeof portfolio.hhi, "number");
});

test("Dispute lifecycle: tampered evidence routes through court + vault", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases({ tamperEnergy: true });
  const audit = await econ.runWatchdogAudit(reports);
  assert.equal(audit.disputed, true);
  const disputes = econ.ledger.disputes.list();
  assert.ok(disputes.length >= 1);
  assert.equal(disputes[0]!.verdict, "agent_loses");
  assert.ok(econ.ledger.slashing.totalSlashed() > 0n);
});
