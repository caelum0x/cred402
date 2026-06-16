import { test } from "node:test";
import assert from "node:assert/strict";

import { Cred402Economy } from "../agents/economy.js";
import { Ledger } from "../lib/ledger/index.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { buildAgentDossier } from "../lib/services/agent_dossier.js";
import { buildAgentHealthBadge } from "../lib/services/agent_health.js";

test("dossier: bundles the bureau view and stays consistent with standalone reads", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  const id = econ.seller.agent_id;
  const att = new AttestationGraph(econ.ledger);

  const d = buildAgentDossier(econ.ledger, att, id);
  assert.ok(!("error" in d));
  if ("error" in d) return;

  assert.equal(d.agent_id, id);
  assert.equal(d.reputation, econ.ledger.agents.get(id)!.reputation_score);
  // the bundled health matches the standalone health endpoint
  const standalone = buildAgentHealthBadge(econ.ledger, id);
  if (!("error" in standalone)) {
    assert.equal(d.health.status, standalone.status);
    assert.equal(d.health.score, standalone.score);
  }
  assert.ok(["green", "amber", "red", "unknown"].includes(d.health.status));
  assert.equal(typeof d.readiness.ready, "boolean");
});

test("dossier: unknown agent → error", () => {
  const l = new Ledger();
  assert.ok("error" in buildAgentDossier(l, new AttestationGraph(l), "Ghost"));
});
