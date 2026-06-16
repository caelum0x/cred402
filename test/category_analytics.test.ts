import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { buildCategoryAnalytics } from "../lib/services/category_analytics.js";

test("categories: rolls agents up by service type with reconciling counts", () => {
  const l = new Ledger();
  const reg = (id: string, svc: "monitoring" | "weather_risk", rep: number) => {
    l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: svc });
    l.agents.seed_profile(id, { reputation_score: rep });
  };
  reg("M1", "monitoring", 80);
  reg("M2", "monitoring", 60);
  reg("W1", "weather_risk", 70);

  const cats = buildCategoryAnalytics(l).categories;
  const monitoring = cats.find((c) => c.category === "monitoring")!;
  assert.equal(monitoring.agent_count, 2);
  assert.equal(monitoring.avg_reputation, 70); // (80 + 60) / 2
  const weather = cats.find((c) => c.category === "weather_risk")!;
  assert.equal(weather.agent_count, 1);
  // every registered agent is accounted for in exactly one category
  const total = cats.reduce((s, c) => s + c.agent_count, 0);
  assert.equal(total, l.agents.list().length);
});

test("categories: sorted by total revenue descending", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);

  const cats = buildCategoryAnalytics(econ.ledger).categories;
  for (let i = 1; i < cats.length; i++) {
    assert.ok(BigInt(cats[i - 1]!.total_revenue_motes) >= BigInt(cats[i]!.total_revenue_motes));
  }
});
