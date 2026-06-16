import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";

/**
 * The batch-registration handler logic mirrored at the ledger level: register many
 * agents, collecting per-item ok/error (duplicates fail without aborting the batch).
 */
function registerBatch(l: Ledger, agents: { agent_id: string; service_type: "monitoring" }[]) {
  const results = agents.map((a) => {
    try {
      l.agents.register_agent({ agent_id: a.agent_id, owner_public_key: "01", agent_public_key: "01", service_type: a.service_type });
      return { agent_id: a.agent_id, ok: true as const };
    } catch (err) {
      return { agent_id: a.agent_id, ok: false as const, error: (err as Error).message };
    }
  });
  return { registered: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
}

test("batch register: registers all-new agents", () => {
  const l = new Ledger();
  const r = registerBatch(l, [
    { agent_id: "A1", service_type: "monitoring" },
    { agent_id: "A2", service_type: "monitoring" },
  ]);
  assert.equal(r.registered, 2);
  assert.equal(r.failed, 0);
  assert.ok(l.agents.get("A1"));
  assert.ok(l.agents.get("A2"));
});

test("batch register: a duplicate fails without aborting the batch", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "Dup", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  const r = registerBatch(l, [
    { agent_id: "Dup", service_type: "monitoring" }, // already exists
    { agent_id: "New", service_type: "monitoring" }, // still registers
  ]);
  assert.equal(r.registered, 1);
  assert.equal(r.failed, 1);
  assert.equal(r.results.find((x) => x.agent_id === "Dup")!.ok, false);
  assert.ok(l.agents.get("New"));
});
