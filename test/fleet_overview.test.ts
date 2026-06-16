import { test } from "node:test";
import assert from "node:assert/strict";

import { ServerState } from "../api/state.js";

test("fleet: summarizes readiness + discovery for a list, flagging unknowns", async () => {
  const state = new ServerState();
  // The bootstrapped economy has a seller agent; include a bogus id too.
  const seller = state.economy.seller.agent_id;
  const overview = state.fleetOverview([seller, "definitely-not-real"]);

  assert.equal(overview.count, 2);
  assert.equal(overview.unknown, 1);
  const sellerRow = overview.agents.find((a) => a.agent_id === seller)!;
  assert.equal(sellerRow.exists, true);
  assert.equal(typeof sellerRow.readiness_pct, "number");
  assert.ok("discovery_score" in sellerRow);
  const ghost = overview.agents.find((a) => a.agent_id === "definitely-not-real")!;
  assert.equal(ghost.exists, false);
  // counts reconcile
  assert.equal(overview.ready + overview.not_ready + overview.unknown, overview.count);
});

test("fleet: an empty list returns a zeroed summary", () => {
  const state = new ServerState();
  const overview = state.fleetOverview([]);
  assert.equal(overview.count, 0);
  assert.equal(overview.ready, 0);
  assert.deepEqual(overview.agents, []);
});
