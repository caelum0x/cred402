import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { buildAgentMultichainSummary } from "../lib/services/agent_multichain.js";

test("multichain: unknown agent → error", () => {
  const l = new Ledger();
  assert.ok("error" in buildAgentMultichainSummary(l, "Ghost"));
});

test("multichain: aggregates CANs per target chain under the shared exposure cap", () => {
  const l = new Ledger();
  const econ = new Cred402Economy(l);
  econ.bootstrap();
  const agentId = econ.seller.agent_id;
  l.exposure.ensure_agent(agentId, 1_000_000_000n);

  l.notes.issue_can({ agent_id: agentId, credit_score: 80, risk_policy_version: 1, target_chain: "eip155:8453", target_pool: "0xpool", max_draw: 100_000_000n, asset: "USDC" });
  l.notes.issue_can({ agent_id: agentId, credit_score: 80, risk_policy_version: 1, target_chain: "solana:mainnet", target_pool: "Sol1", max_draw: 100_000_000n, asset: "USDC" });

  const summary = buildAgentMultichainSummary(l, agentId);
  assert.ok(!("error" in summary));
  if ("error" in summary) return;
  assert.equal(summary.total_credit_notes, 2);
  const chains = summary.chains.map((c) => c.chain).sort();
  assert.deepEqual(chains, ["eip155:8453", "solana:mainnet"]);
  // exposure reserved by the two CANs is reflected in the shared cap
  assert.ok(summary.global_exposure);
  assert.equal(summary.global_exposure!.reserved, "200000000");
});

test("multichain: an agent with no cross-chain activity has empty chains", () => {
  const l = new Ledger();
  const econ = new Cred402Economy(l);
  econ.bootstrap();
  const summary = buildAgentMultichainSummary(l, econ.seller.agent_id);
  if ("error" in summary) return assert.fail("expected summary");
  assert.equal(summary.total_bindings, 0);
  assert.equal(summary.total_external_receipts, 0);
  assert.deepEqual(summary.chains, []);
});
