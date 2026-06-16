import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { discoverAgents } from "../lib/services/discovery.js";

function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const attestations = new AttestationGraph(ledger);
  return { ledger, econ, attestations };
}

test("discovery: ranks agents by composite score, clamped 0..100, sorted desc", () => {
  const { ledger, attestations } = setup();
  const res = discoverAgents(ledger, attestations, {});
  assert.ok(res.results.length > 0);
  // ranks are dense and 1-based
  res.results.forEach((r, i) => assert.equal(r.rank, i + 1));
  // scores in range and monotonically non-increasing
  for (let i = 1; i < res.results.length; i++) {
    const prev = res.results[i - 1]!;
    const cur = res.results[i]!;
    assert.ok(cur.score >= 0 && cur.score <= 100);
    assert.ok(prev.score >= cur.score);
  }
});

test("discovery: a vouch lifts the target's trust component and score", () => {
  const { ledger, attestations } = setup();
  const agents = ledger.agents.list();
  // pick a high-rep agent as attester and a different agent as target
  const attester = agents.find((a) => a.reputation_score >= 60);
  const target = agents.find((a) => a.agent_id !== attester?.agent_id);
  assert.ok(attester && target, "need two agents");

  const before = discoverAgents(ledger, attestations, {}).results.find((r) => r.agent_id === target!.agent_id)!;
  attestations.attest(attester!.agent_id, target!.agent_id, "vouch");
  const after = discoverAgents(ledger, attestations, {}).results.find((r) => r.agent_id === target!.agent_id)!;

  assert.ok(after.trust_score > before.trust_score);
  assert.ok(after.vouches > before.vouches);
  assert.ok(after.score >= before.score);
});

test("discovery: service_type and min_reputation filters apply", () => {
  const { ledger, attestations } = setup();
  const sample = ledger.agents.list()[0]!;
  const filtered = discoverAgents(ledger, attestations, { service_type: sample.service_type });
  assert.ok(filtered.results.every((r) => r.service_type === sample.service_type));

  const high = discoverAgents(ledger, attestations, { min_reputation: 200 });
  assert.equal(high.count, 0); // nobody has reputation >= 200

  const limited = discoverAgents(ledger, attestations, { limit: 1 });
  assert.ok(limited.results.length <= 1);
});
