import { test } from "node:test";
import assert from "node:assert/strict";

import { WebhookService } from "../lib/gateway/webhooks.js";

function svc(statuses: number[]) {
  let i = 0;
  // a fetch stub that returns the next queued status (defaults to 200)
  const fetchFn = async () => ({ status: statuses[i++] ?? 200 });
  let clock = 1000;
  return new WebhookService(2, fetchFn, () => clock++, async () => {});
}

test("webhook deliveries: records delivered attempts, newest first", async () => {
  const s = svc([200, 200]);
  s.subscribe("https://example.com/hook", ["*"]);
  await s.dispatch("CreditDrawn", { agent_id: "A", amount: "1" });
  await s.dispatch("CreditRepaid", { agent_id: "A", principal: "1" });

  const log = s.deliveries();
  assert.equal(log.length, 2);
  assert.equal(log[0]!.event, "CreditRepaid"); // newest first
  assert.equal(log[0]!.status, "delivered");
  assert.ok(log.every((d) => typeof d.at === "number"));
});

test("webhook deliveries: a failing endpoint is logged as failed after retries", async () => {
  const s = svc([500, 500, 500]); // always 500 → exhausts retries
  const sub = s.subscribe("https://example.com/hook", ["*"]);
  await s.dispatch("CreditDrawn", { agent_id: "A", amount: "1" });
  const log = s.deliveries(sub.id);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.status, "failed");
  assert.ok(log[0]!.attempts >= 1);
});

test("webhook deliveries: filters by subscription id", async () => {
  const s = svc([200, 200]);
  const a = s.subscribe("https://a.example.com/hook", ["*"]);
  s.subscribe("https://b.example.com/hook", ["*"]);
  await s.dispatch("CreditDrawn", { agent_id: "X", amount: "1" });
  const onlyA = s.deliveries(a.id);
  assert.ok(onlyA.every((d) => d.subscription_id === a.id));
  assert.equal(onlyA.length, 1);
});
