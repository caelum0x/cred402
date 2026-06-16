import { test } from "node:test";
import assert from "node:assert/strict";

import { Cred402Economy } from "../agents/economy.js";
import { Ledger } from "../lib/ledger/index.js";
import { reviewCreditLine } from "../lib/services/credit_review.js";
import { cspr } from "../lib/core/units.js";

async function underwrittenAgent() {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.underwriteSeller();
  return { econ, agentId: econ.seller.agent_id };
}

test("review: no line → error", () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  const r = reviewCreditLine(econ.ledger, econ.credit, "Nobody");
  assert.ok("error" in r);
});

test("review: ratchets the limit UP when revenue grows", async () => {
  const { econ, agentId } = await underwrittenAgent();
  const before = econ.ledger.pool.get(agentId)!.max_credit;

  // Simulate strong new revenue within the 30-day window → higher recommended limit.
  const serviceType = econ.ledger.agents.get(agentId)!.service_type;
  for (let i = 0; i < 10; i++) {
    econ.ledger.agents.record_job(
      agentId,
      { receipt_id: `r${i}`, amount: cspr(20), timestamp: econ.ledger.clock.now(), service_type: serviceType },
      95,
      false,
    );
  }

  const r = reviewCreditLine(econ.ledger, econ.credit, agentId);
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.action, "increased");
  assert.ok(BigInt(r.new_limit_motes) > before, "limit should rise");
  assert.equal(econ.ledger.pool.get(agentId)!.max_credit.toString(), r.new_limit_motes);
});

test("review: HOLDS (never reduces) when fresh underwriting would grant less", async () => {
  const { econ, agentId } = await underwrittenAgent();
  // Artificially inflate the current limit above what underwriting would now grant.
  const line = econ.ledger.pool.get(agentId)!;
  const inflated = line.max_credit * 4n;
  econ.ledger.pool.open_credit_line({ agent_id: agentId, max_credit: inflated, interest_rate_bps: line.interest_rate_bps, origination_fee_bps: 0, term_seconds: 86_400 });

  const r = reviewCreditLine(econ.ledger, econ.credit, agentId);
  if ("error" in r) return assert.fail("expected a review");
  assert.equal(r.action, "held");
  // the line is NOT reduced
  assert.equal(econ.ledger.pool.get(agentId)!.max_credit, inflated);
  assert.equal(r.new_limit_motes, inflated.toString());
});

test("review: an ineligible agent has its limit held, not yanked", async () => {
  const { econ, agentId } = await underwrittenAgent();
  const before = econ.ledger.pool.get(agentId)!.max_credit;
  // Open a dispute to make the agent ineligible to draw.
  econ.ledger.disputes.open({ dispute_type: "bad_evidence", complainant: "W", respondent_agent: agentId, note: "x", evidence_hash: "0x1" });

  const r = reviewCreditLine(econ.ledger, econ.credit, agentId);
  if ("error" in r) return assert.fail("expected a review");
  assert.equal(r.action, "ineligible");
  assert.equal(econ.ledger.pool.get(agentId)!.max_credit, before); // held
});
