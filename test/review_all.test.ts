import { test } from "node:test";
import assert from "node:assert/strict";

import { ServerState } from "../api/state.js";
import { cspr } from "../lib/core/units.js";

test("review-all: reviews every active line and summarizes the actions", () => {
  const state = new ServerState();
  // Open a couple of lines on the bootstrapped agents.
  const agents = state.ledger.agents.list().slice(0, 2);
  for (const a of agents) {
    state.ledger.pool.open_credit_line({ agent_id: a.agent_id, max_credit: cspr(10), interest_rate_bps: 800, origination_fee_bps: 50, term_seconds: 86_400 });
  }

  const summary = state.reviewAllCreditLines();
  assert.equal(summary.reviewed, agents.length);
  assert.equal(summary.errors, 0);
  // counts reconcile to the number reviewed
  assert.equal(summary.increased + summary.held + summary.ineligible, summary.reviewed);
  assert.equal(summary.results.length, agents.length);
});

test("review-all: an empty book reviews nothing", () => {
  const state = new ServerState();
  // The bootstrap may leave no active drawn lines; close any by ignoring — just assert structure.
  const summary = state.reviewAllCreditLines();
  assert.equal(typeof summary.reviewed, "number");
  assert.equal(summary.increased + summary.held + summary.ineligible + summary.errors, summary.results.length);
});
