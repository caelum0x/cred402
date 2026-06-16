import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { buildOnboardingScorecard } from "../lib/services/onboarding_scorecard.js";

test("scorecard: a fresh low-reputation agent is not ready and lists the blocking gap", () => {
  const ledger = new Ledger();
  ledger.agents.register_agent({ agent_id: "Fresh", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  ledger.agents.update_reputation("Fresh", -50, "0x0"); // 70 → 20, below the 40 floor

  const card = buildOnboardingScorecard(ledger, "Fresh");
  assert.ok(!("error" in card));
  if ("error" in card) return;
  assert.equal(card.ready, false);
  const repItem = card.items.find((i) => i.requirement.startsWith("Reputation"))!;
  assert.equal(repItem.met, false);
  assert.ok(repItem.blocking);
  assert.ok(card.readiness_pct < 100);
});

test("scorecard: an agent meeting every blocking gate is ready", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  const card = buildOnboardingScorecard(econ.ledger, econ.seller.agent_id);
  if ("error" in card) return assert.fail("expected a scorecard");
  // every blocking item is satisfied → ready, even if optional items remain
  assert.ok(card.items.filter((i) => i.blocking).every((i) => i.met));
  assert.equal(card.ready, true);
  assert.ok(card.readiness_pct >= 50);
});

test("scorecard: unknown agent returns an error", () => {
  const ledger = new Ledger();
  const card = buildOnboardingScorecard(ledger, "Ghost");
  assert.ok("error" in card);
});
