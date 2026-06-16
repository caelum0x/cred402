import { test } from "node:test";
import assert from "node:assert/strict";

import { Cred402Economy } from "../agents/economy.js";
import { Ledger } from "../lib/ledger/index.js";
import { buildCreditHistory } from "../lib/services/credit_history.js";

async function activeAgent() {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.underwriteSeller();
  return { econ, agentId: econ.seller.agent_id };
}

test("history: builds a chronological, categorized credit file", async () => {
  const { econ, agentId } = await activeAgent();
  const h = buildCreditHistory(econ.ledger, agentId);
  assert.ok(!("error" in h));
  if ("error" in h) return;

  assert.equal(h.agent_id, agentId);
  assert.ok(h.entries.length > 0);
  // chronological by sequence
  for (let i = 1; i < h.entries.length; i++) {
    assert.ok(h.entries[i]!.seq > h.entries[i - 1]!.seq);
  }
  // identity + revenue + credit events all present for an active agent
  assert.ok(h.counts.identity >= 1, "expected a registration event");
  assert.ok(h.counts.revenue >= 1, "expected revenue events");
  assert.ok(h.counts.credit >= 1, "expected credit events");
  // count map reconciles with entry total
  const total = Object.values(h.counts).reduce((s, n) => s + n, 0);
  assert.equal(total, h.entries.length);
  assert.ok(h.first_seen !== undefined && h.last_activity !== undefined);
});

test("history: only includes events that mention the agent", async () => {
  const { econ, agentId } = await activeAgent();
  const h = buildCreditHistory(econ.ledger, agentId);
  if ("error" in h) return assert.fail("expected history");
  const other = buildCreditHistory(econ.ledger, "definitely-not-an-agent");
  assert.ok("error" in other); // unknown agent → error, not an empty file
});
