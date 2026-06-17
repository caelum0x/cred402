import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { DisputeJury } from "../lib/services/dispute_jury.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p6 — decentralized dispute jury. A staked, reputable panel votes the
 * verdict; consensus jurors earn reputation, dissenters/no-shows lose it; the
 * majority verdict is issued on the DisputeCourt. Panel selection is deterministic
 * and rooted in the dispute id (verifiable, ungrindable).
 */

function registerJuror(l: Ledger, id: string, rep: number) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01a", agent_public_key: "01b", service_type: "data.market" });
  l.agents.stake(id, cspr(50));
  if (rep !== 70) l.agents.update_reputation(id, rep - 70, "0x", "seed");
}

function openDispute(l: Ledger) {
  return l.disputes.open({
    dispute_type: "fake_receipt",
    complainant: "Victim",
    respondent_agent: "Accused",
    note: "submitted a fabricated receipt",
    evidence_hash: "0xevidence",
  });
}

function setup() {
  const l = new Ledger();
  // parties to the dispute (excluded from juror pool)
  registerJuror(l, "Victim", 70);
  registerJuror(l, "Accused", 70);
  // candidate jurors
  for (const j of ["J1", "J2", "J3", "J4", "J5", "J6"]) registerJuror(l, j, 80);
  return l;
}

test("p6 jury: deterministic panel of the configured size, excludes the parties", () => {
  const l = setup();
  const d = openDispute(l);
  const jury = new DisputeJury(l, { panel_size: 5 });
  const panel = jury.empanel(d.dispute_id);
  assert.equal(panel.jurors.length, 5);
  assert.ok(!panel.jurors.includes("Victim") && !panel.jurors.includes("Accused"));
  // deterministic: re-empaneling returns the same panel
  assert.deepEqual(new DisputeJury(l, { panel_size: 5 }).empanel(d.dispute_id).jurors, panel.jurors);
});

test("p6 jury: majority slash verdict is issued with the median proposed slash", () => {
  const l = setup();
  const d = openDispute(l);
  const jury = new DisputeJury(l, { panel_size: 5, quorum_bps: 6000 });
  const panel = jury.empanel(d.dispute_id);
  const [a, b, c, d4, e] = panel.jurors;
  jury.castVote(d.dispute_id, a!, "agent_loses", { proposed_slash_motes: cspr(10) });
  jury.castVote(d.dispute_id, b!, "agent_loses", { proposed_slash_motes: cspr(20) });
  jury.castVote(d.dispute_id, c!, "agent_loses", { proposed_slash_motes: cspr(30) });
  jury.castVote(d.dispute_id, d4!, "agent_wins");
  // e abstains

  const outcome = jury.tally(d.dispute_id);
  assert.equal(outcome.quorum_met, true);
  assert.equal(outcome.verdict, "agent_loses");
  assert.equal(outcome.slash_amount_motes, cspr(20).toString(), "median of 10/20/30");
  assert.equal(outcome.majority_size, 3);
  // verdict landed on the DisputeCourt
  const dispute = l.disputes.get(d.dispute_id)!;
  assert.equal(dispute.status, "resolved");
  assert.equal(dispute.verdict, "agent_loses");
  assert.equal(dispute.slash_amount, cspr(20));
});

test("p6 jury: consensus jurors gain reputation, dissenters/absentees lose it", () => {
  const l = setup();
  const d = openDispute(l);
  const jury = new DisputeJury(l, { panel_size: 5, quorum_bps: 6000, juror_reward: 2, juror_penalty: -3 });
  const panel = jury.empanel(d.dispute_id);
  const [a, b, c, d4] = panel.jurors;
  const dissenter = d4!;
  const absentee = panel.jurors[4]!;
  jury.castVote(d.dispute_id, a!, "agent_loses", { proposed_slash_motes: cspr(10) });
  jury.castVote(d.dispute_id, b!, "agent_loses", { proposed_slash_motes: cspr(10) });
  jury.castVote(d.dispute_id, c!, "agent_loses", { proposed_slash_motes: cspr(10) });
  jury.castVote(d.dispute_id, dissenter, "agent_wins");

  const repBefore = l.agents.get(a!)!.reputation_score;
  const dissenterBefore = l.agents.get(dissenter)!.reputation_score;
  const absenteeBefore = l.agents.get(absentee)!.reputation_score;
  const outcome = jury.tally(d.dispute_id);

  assert.ok(outcome.rewarded.includes(a!));
  assert.ok(outcome.penalized.includes(dissenter));
  assert.ok(outcome.penalized.includes(absentee), "no-show is penalized");
  assert.equal(l.agents.get(a!)!.reputation_score, repBefore + 2);
  assert.equal(l.agents.get(dissenter)!.reputation_score, dissenterBefore - 3);
  assert.equal(l.agents.get(absentee)!.reputation_score, absenteeBefore - 3);
});

test("p6 jury: no quorum => agent wins, no verdict issued", () => {
  const l = setup();
  const d = openDispute(l);
  const jury = new DisputeJury(l, { panel_size: 5, quorum_bps: 6000 });
  const panel = jury.empanel(d.dispute_id);
  // only 1 of 5 votes (needs 3)
  jury.castVote(d.dispute_id, panel.jurors[0]!, "agent_loses", { proposed_slash_motes: cspr(10) });
  const outcome = jury.tally(d.dispute_id);
  assert.equal(outcome.quorum_met, false);
  assert.equal(outcome.verdict, "agent_wins");
  assert.equal(outcome.resolved, false);
  assert.equal(l.disputes.get(d.dispute_id)!.status, "opened", "no verdict issued");
});

test("p6 jury: a non-empaneled agent cannot vote; an agent_wins vote cannot slash", () => {
  const l = setup();
  const d = openDispute(l);
  const jury = new DisputeJury(l, { panel_size: 5 });
  jury.empanel(d.dispute_id);
  assert.throws(() => jury.castVote(d.dispute_id, "Victim", "agent_loses"), /not on the panel/);
  const seat = jury.panel(d.dispute_id)!.jurors[0]!;
  assert.throws(() => jury.castVote(d.dispute_id, seat, "agent_wins", { proposed_slash_motes: cspr(5) }), /cannot propose a slash/);
});
