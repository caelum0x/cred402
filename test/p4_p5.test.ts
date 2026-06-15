import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { cspr } from "../lib/core/units.js";
import type { Agent } from "../lib/core/types.js";
import { reasonCodesFromInputs } from "../lib/core/reason_codes.js";
import { ProtocolEconomics, DEFAULT_FEE_SCHEDULE } from "../lib/core/economics.js";
import { Marketplace, SERVICE_CATEGORIES } from "../lib/services/marketplace.js";
import { FinalityPolicy } from "../crosschain/trust-ladder/finality.js";
import { MultiRelayerCoordinator } from "../crosschain/trust-ladder/multi_relayer.js";
import { ProofTypeRegistry, type ThresholdProof } from "../crosschain/trust-ladder/proof_types.js";
import { ProofService } from "../crosschain/proof-service/proof_service.js";
import { generateAgentKeypair } from "../lib/x402/keys.js";

function agent(over: Partial<Agent> = {}): Agent {
  return {
    agent_id: "a1",
    owner_public_key: "01",
    agent_public_key: "01",
    service_type: "solar_output_verification",
    stake: cspr(50),
    total_jobs_completed: 100,
    x402_revenue_history: [],
    accuracy_score: 92,
    dispute_rate: 0.017,
    reputation_score: 90,
    credit_score: 0,
    active: true,
    registered_at: 0,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// p5 §15 — reason codes
// ---------------------------------------------------------------------------

test("reason codes: a strong agent earns positive codes and no new-agent cap", () => {
  const codes = reasonCodesFromInputs({
    agent: agent(),
    finalizedReceiptCount: 12,
    verifiedEvidenceCount: 3,
    repaymentCount: 2,
    topCounterpartyShare: 0.3,
    suspiciousFraudFlags: [],
    creditLine: cspr(10),
    overdue: false,
    badEvidenceVerdict: false,
  });
  const set = new Set(codes.map((c) => c.code));
  assert.ok(set.has("FINALIZED_X402_REVENUE"));
  assert.ok(set.has("LOW_DISPUTE_RATE"));
  assert.ok(set.has("VALID_RWA_EVIDENCE"));
  assert.ok(set.has("STAKE_BACKING"));
  assert.ok(set.has("STRONG_REPAYMENT_HISTORY"));
  assert.ok(set.has("SERVICE_CATEGORY_EXPERTISE"));
  assert.ok(set.has("COUNTERPARTY_DIVERSITY"));
  assert.ok(!set.has("NEW_AGENT_LIMIT"));
  assert.ok(codes.every((c) => c.polarity === "positive"));
});

test("reason codes: weak/new/risky agent earns negative codes", () => {
  const codes = reasonCodesFromInputs({
    agent: agent({ total_jobs_completed: 2, dispute_rate: 0.12, stake: cspr(1) }),
    finalizedReceiptCount: 0,
    verifiedEvidenceCount: 0,
    repaymentCount: 0,
    topCounterpartyShare: 0.95,
    suspiciousFraudFlags: ["reciprocal_loop"],
    creditLine: cspr(10),
    overdue: true,
    badEvidenceVerdict: true,
  });
  const set = new Set(codes.map((c) => c.code));
  assert.ok(set.has("NEW_AGENT_LIMIT"));
  assert.ok(set.has("HIGH_DISPUTE_RATE"));
  assert.ok(set.has("LOW_STAKE_COVERAGE"));
  assert.ok(set.has("SUSPICIOUS_RECEIPT_PATTERN"));
  assert.ok(set.has("HIGH_COUNTERPARTY_CONCENTRATION"));
  assert.ok(set.has("OVERDUE_CREDIT"));
  assert.ok(set.has("BAD_EVIDENCE_VERDICT"));
});

test("reason codes: the honest economy loop attaches structured codes to the decision", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  await econ.runEvidencePurchases();
  econ.scoreJob();
  const { decision } = econ.credit.underwrite(econ.seller.agent_id);
  assert.ok(decision.reason_codes && decision.reason_codes.length > 0);
  const set = new Set(decision.reason_codes!.map((c) => c.code));
  assert.ok(set.has("STAKE_BACKING"));
  assert.ok(set.has("SERVICE_CATEGORY_EXPERTISE"));
});

// ---------------------------------------------------------------------------
// p4 §11 — protocol economics & fee model
// ---------------------------------------------------------------------------

test("economics: fees, interest spread and slash route match p4 §11.2", () => {
  const econ = new ProtocolEconomics();
  // facilitator 0.30% of 100 CSPR = 0.3 CSPR
  assert.equal(econ.facilitatorFee(cspr(100)), cspr("0.3"));
  // origination 0.50% of 40 CSPR = 0.2 CSPR
  assert.equal(econ.originationFee(cspr(40)), cspr("0.2"));
  // interest spread: protocol takes 10%, LPs get 90%
  const interest = cspr(10);
  assert.equal(econ.protocolInterestShare(interest), cspr(1));
  assert.equal(econ.lpInterestShare(interest), cspr(9));
  // slash route 50/25/25, sums exactly to the amount
  const split = econ.slashSplit(cspr(100));
  assert.equal(split.to_victim, cspr(50));
  assert.equal(split.to_insurance, cspr(25));
  assert.equal(split.to_treasury, cspr(25));
  assert.equal(split.to_victim + split.to_insurance + split.to_treasury + split.to_burn, cspr(100));
  assert.equal(DEFAULT_FEE_SCHEDULE.interest_spread_bps, 1000n);
});

test("economics: pool health reports honest realized APY and risk flags", () => {
  const econ = new ProtocolEconomics();
  const healthy = econ.poolHealth({
    total_liquidity: cspr(1000),
    outstanding_credit: cspr(500),
    interest_accrued: cspr(50),
    fees_collected: cspr(5),
    default_losses: 0n,
    elapsed_seconds: 365 * 24 * 60 * 60,
  });
  assert.ok(Math.abs(healthy.utilization - 0.5) < 1e-9);
  assert.equal(healthy.realized_yield, cspr(55));
  assert.ok(healthy.realized_apy > 0);
  assert.deepEqual(healthy.risk_flags, []);

  const lossy = econ.poolHealth({
    total_liquidity: cspr(1000),
    outstanding_credit: cspr(950),
    interest_accrued: cspr(10),
    fees_collected: 0n,
    default_losses: cspr(40),
    elapsed_seconds: 365 * 24 * 60 * 60,
  });
  assert.equal(lossy.realized_yield, cspr(-30));
  assert.ok(lossy.risk_flags.some((f) => f.includes("default losses")));
  assert.ok(lossy.risk_flags.some((f) => f.includes("high utilization")));
  assert.ok(lossy.risk_flags.some((f) => f.includes("negative")));
});

// ---------------------------------------------------------------------------
// p4 §18 — marketplace
// ---------------------------------------------------------------------------

test("marketplace: lists services and quotes each pricing strategy", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "S", owner_public_key: "01", agent_public_key: "01", service_type: "weather_risk" });
  l.agents.seed_profile("S", { reputation_score: 80 });
  const mkt = new Marketplace(l);

  const fixed = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "fixed", base_price: cspr(1) });
  assert.equal(mkt.quote(fixed.listing_id).price, cspr(1));

  const dyn = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "dynamic", base_price: cspr(1) });
  assert.equal(mkt.quote(dyn.listing_id, { load: 1 }).price, cspr(2)); // 2x at full load

  const urg = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "urgency", base_price: cspr(1) });
  assert.equal(mkt.quote(urg.listing_id, { urgency: 3 }).price, cspr(3));

  const auc = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "auction", base_price: cspr(1), margin_bps: 0n });
  assert.equal(mkt.quote(auc.listing_id, { bids: [cspr(5), cspr(3)] }).price, cspr(5));

  const rep = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "reputation_tiered", base_price: cspr(1) });
  // rep 80 → factor 1.30
  assert.equal(mkt.quote(rep.listing_id).price, cspr("1.3"));

  const cost = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "data_cost_plus", base_price: cspr(1), margin_bps: 2000n });
  // data 10 + 20% + base 1 = 13
  assert.equal(mkt.quote(cost.listing_id, { data_cost: cspr(10) }).price, cspr(13));

  // min_payment floor + unknown category rejection
  const floor = mkt.list({ agent_id: "S", category: "rwa.weather_risk", strategy: "dynamic", base_price: cspr(2), min_payment: cspr(1) });
  assert.equal(mkt.quote(floor.listing_id, { load: 0 }).price, cspr(2)); // base ≥ min
  assert.throws(() => mkt.list({ agent_id: "S", category: "not.a.category" as never, strategy: "fixed", base_price: cspr(1) }), /unknown service category/);
  assert.equal(SERVICE_CATEGORIES.length, 16);
});

test("marketplace: enriched listings carry trust signals ranked by reputation", () => {
  const l = new Ledger();
  for (const [id, rep] of [["A", 60], ["B", 95]] as const) {
    l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "weather_risk" });
    l.agents.seed_profile(id, { reputation_score: rep });
  }
  const mkt = new Marketplace(l);
  mkt.list({ agent_id: "A", category: "rwa.weather_risk", strategy: "fixed", base_price: cspr(1) });
  mkt.list({ agent_id: "B", category: "rwa.weather_risk", strategy: "fixed", base_price: cspr(1) });
  const listings = mkt.enriched("rwa.weather_risk");
  assert.equal(listings.length, 2);
  assert.equal(listings[0]!.agent_id, "B"); // highest reputation first
  assert.ok(listings[0]!.supported_chains.includes("casper"));
});

// ---------------------------------------------------------------------------
// p4 §26 — cross-chain trust ladder
// ---------------------------------------------------------------------------

test("trust ladder stage 3: finality policy enforces confirmations and time", () => {
  const fp = new FinalityPolicy();
  // Base needs 20 confirmations + 24s.
  assert.equal(fp.isFinal("eip155:8453", 100, 110, 0, 100).final, false); // only 10 confs
  assert.equal(fp.isFinal("eip155:8453", 100, 130, 0, 10).final, false); // only 10s
  assert.equal(fp.isFinal("eip155:8453", 100, 130, 0, 100).final, true); // 30 confs, 100s
  // unknown chain → very conservative, not final
  assert.equal(fp.isFinal("unknownchain", 0, 1, 0, 1).final, false);
});

test("trust ladder stage 2: multi-relayer quorum finalizes and slashes a liar", () => {
  const chain = "eip155:8453";
  const coord = new MultiRelayerCoordinator(chain, 2, 60);
  const r1 = coord.registerRelayer(generateAgentKeypair(), cspr(100));
  const r2 = coord.registerRelayer(generateAgentKeypair(), cspr(100));
  const liar = coord.registerRelayer(generateAgentKeypair(), cspr(100));

  coord.submit(r1.attest(chain, 1, "0xROOT"));
  coord.submit(r2.attest(chain, 1, "0xROOT"));
  coord.submit(liar.attest(chain, 1, "0xFORGED"));

  assert.throws(() => coord.finalize(1, 0, 30), /challenge window/);
  const status = coord.finalize(1, 0, 120);
  assert.equal(status.status, "finalized");
  assert.equal(status.agreed_root, "0xROOT");
  assert.equal(status.attesters.length, 2);
  assert.deepEqual(status.challengers, [liar.key]);
  // The liar's bond is slashed to zero.
  assert.equal(coord.relayer(liar.key)!.bond, 0n);
  assert.equal(coord.relayer(liar.key)!.slashed, cspr(100));
  assert.equal(coord.relayer(r1.key)!.bond, cspr(100));
});

test("trust ladder stage 2: no quorum when relayers disagree without a majority", () => {
  const chain = "solana";
  const coord = new MultiRelayerCoordinator(chain, 2, 0);
  const a = coord.registerRelayer(generateAgentKeypair(), cspr(10));
  const b = coord.registerRelayer(generateAgentKeypair(), cspr(10));
  coord.submit(a.attest(chain, 5, "0xA"));
  coord.submit(b.attest(chain, 5, "0xB"));
  const status = coord.finalize(5, 0, 1);
  assert.equal(status.status, "no_quorum");
});

test("trust ladder stage 4: proof-type registry verifies merkle + threshold, rejects zk honestly", () => {
  const svc = new ProofService();
  const batch = svc.commitBatch([{ origin_chain: "eip155:8453", event_type: "ReceiptCreated", observed_at: 0, payload: { a: 1 } }]);
  const registry = ProofTypeRegistry.withDefaults(new Set([svc.relayerKey]));

  // merkle proof verifies
  assert.equal(registry.verify({ type: "merkle", proof: batch.proofs[0]! }).ok, true);

  // threshold proof verifies with quorum, fails below it
  const ok: ThresholdProof = { type: "threshold", height: 1, root: "0xR", attesters: ["k1", "k2"], quorum: 2 };
  const short: ThresholdProof = { type: "threshold", height: 1, root: "0xR", attesters: ["k1"], quorum: 2 };
  assert.equal(registry.verify(ok).ok, true);
  assert.equal(registry.verify(short).ok, false);

  // zk / light_client honestly unavailable
  assert.equal(registry.verify({ type: "zk" }).ok, false);
  assert.equal(registry.verify({ type: "light_client" }).ok, false);
  assert.deepEqual(registry.supported(), ["merkle", "threshold"]);
});
