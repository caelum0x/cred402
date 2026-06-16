import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { cspr } from "../lib/core/units.js";
import { buildDisputeStats } from "../lib/services/dispute_stats.js";

test("dispute stats: empty court is all zeros", () => {
  const s = buildDisputeStats(new Ledger());
  assert.equal(s.total, 0);
  assert.equal(s.resolution_rate, 0);
  assert.equal(s.most_disputed_agent, null);
});

test("dispute stats: aggregates outcomes, types, slashing and the most-disputed agent", () => {
  const l = new Ledger();
  const open = (respondent: string, type: "bad_evidence" | "non_delivery") =>
    l.disputes.open({ dispute_type: type, complainant: "W", respondent_agent: respondent, note: "x", evidence_hash: "0x1" });

  const d1 = open("Bad", "bad_evidence");
  const d2 = open("Bad", "non_delivery"); // Bad is disputed twice
  open("Other", "bad_evidence"); // stays open

  l.disputes.issue_verdict(d1.dispute_id, "agent_loses", cspr(10), ["x"]);
  l.slashing.apply_slash({ agent_id: "Bad", amount: cspr(10), reason: "x", dispute_id: d1.dispute_id });
  l.disputes.issue_verdict(d2.dispute_id, "agent_wins", 0n, ["ok"]);

  const s = buildDisputeStats(l);
  assert.equal(s.total, 3);
  assert.equal(s.open, 1);
  assert.equal(s.resolved, 2);
  assert.equal(s.by_verdict["agent_loses"], 1);
  assert.equal(s.by_verdict["agent_wins"], 1);
  assert.equal(s.by_type["bad_evidence"], 2);
  assert.equal(s.by_type["non_delivery"], 1);
  assert.equal(s.most_disputed_agent?.agent_id, "Bad");
  assert.equal(s.most_disputed_agent?.disputes, 2);
  assert.equal(s.total_slashed_motes, cspr(10).toString());
  assert.equal(s.agent_loss_rate, 0.5); // 1 of 2 resolved
});
