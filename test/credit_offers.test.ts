import { test } from "node:test";
import assert from "node:assert/strict";

import { Cred402Economy } from "../agents/economy.js";
import { Ledger } from "../lib/ledger/index.js";
import { CreditOffers } from "../lib/services/credit_offers.js";

async function readyAgent() {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  const offers = new CreditOffers(econ.ledger, econ.credit);
  return { econ, offers, agentId: econ.seller.agent_id };
}

test("offers: issue → accept opens a line at the offered terms", async () => {
  const { econ, offers, agentId } = await readyAgent();
  const issued = offers.issue(agentId);
  assert.ok(!("error" in issued), "expected an offer");
  if ("error" in issued) return;
  assert.equal(issued.status, "pending");
  assert.ok(BigInt(issued.max_credit_motes) > 0n);

  const accepted = offers.accept(issued.offer_id);
  assert.ok(!("error" in accepted));
  if ("error" in accepted) return;
  assert.equal(accepted.offer.status, "accepted");
  const line = econ.ledger.pool.get(agentId);
  assert.ok(line, "a credit line should now exist");
  assert.equal(line!.max_credit.toString(), issued.max_credit_motes);
  assert.equal(line!.interest_rate_bps, issued.interest_rate_bps);
});

test("offers: accepting twice is rejected (idempotent terminal state)", async () => {
  const { offers, agentId } = await readyAgent();
  const issued = offers.issue(agentId);
  if ("error" in issued) return assert.fail("no offer");
  offers.accept(issued.offer_id);
  const again = offers.accept(issued.offer_id);
  assert.ok("error" in again);
  assert.match((again as { error: string }).error, /accepted/);
});

test("offers: an offer expires and can no longer be accepted", async () => {
  const { econ, offers, agentId } = await readyAgent();
  const issued = offers.issue(agentId, { ttl_seconds: 100 });
  if ("error" in issued) return assert.fail("no offer");
  econ.ledger.clock.advance(200); // past the acceptance deadline
  const listed = offers.list(agentId).find((o) => o.offer_id === issued.offer_id)!;
  assert.equal(listed.status, "expired");
  const accept = offers.accept(issued.offer_id);
  assert.ok("error" in accept);
});

test("offers: decline moves a pending offer to declined", async () => {
  const { offers, agentId } = await readyAgent();
  const issued = offers.issue(agentId);
  if ("error" in issued) return assert.fail("no offer");
  const declined = offers.decline(issued.offer_id);
  assert.ok(!("error" in declined));
  if ("error" in declined) return;
  assert.equal(declined.status, "declined");
});

test("offers: unknown agent yields an error, not an offer", async () => {
  const { offers } = await readyAgent();
  const r = offers.issue("Nobody");
  assert.ok("error" in r);
});

test("offers: issue and accept emit bus events (webhook/SSE/history integration)", async () => {
  const { econ, offers, agentId } = await readyAgent();
  const issued = offers.issue(agentId);
  if ("error" in issued) return assert.fail("no offer");
  offers.accept(issued.offer_id);
  const names = econ.ledger.bus.all().map((e) => e.name);
  assert.ok(names.includes("CreditOfferIssued"), "expected CreditOfferIssued");
  assert.ok(names.includes("CreditOfferAccepted"), "expected CreditOfferAccepted");
});
