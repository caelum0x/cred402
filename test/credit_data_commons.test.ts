import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { CreditDataCommons } from "../lib/services/credit_data_commons.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p6 — credit-data commons (data moat as a public good). An anonymized,
 * k-anonymous protocol snapshot: per-category + per-tier aggregates, no agent ids,
 * thin categories folded into "other". Safe to publish and cite.
 */

function seed(l: Ledger, id: string, service_type: string) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01a", agent_public_key: "01b", service_type });
  l.agents.stake(id, cspr(20));
}

test("p6 commons: snapshot aggregates pool, categories and tiers with no agent ids", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(1000), "lp1");
  for (let i = 0; i < 4; i++) seed(l, `inf${i}`, "inference.llm");
  for (let i = 0; i < 3; i++) seed(l, `data${i}`, "data.market");

  const snap = new CreditDataCommons(l).snapshot();
  assert.equal(snap.agents.total, 7);
  assert.equal(snap.agents.active, 7);
  assert.equal(snap.pool.total_liquidity_motes, cspr(1000).toString());
  // no agent identifiers anywhere in the serialized snapshot
  assert.ok(!JSON.stringify(snap).includes("inf0"));
  // both categories survive k-anonymity (4 and 3 >= k=3)
  const families = snap.by_category.map((c) => c.family).sort();
  assert.deepEqual(families, ["data", "inference"]);
  assert.ok(snap.by_tier.length > 0);
});

test("p6 commons: k-anonymity folds thin categories into 'other'", () => {
  const l = new Ledger();
  for (let i = 0; i < 5; i++) seed(l, `inf${i}`, "inference.llm");
  seed(l, "lonely", "compute.gpu"); // only 1 agent => below k=3, folded into other

  const snap = new CreditDataCommons(l, 3).snapshot();
  const families = snap.by_category.map((c) => c.family);
  assert.ok(families.includes("inference"));
  assert.ok(!families.includes("compute"), "thin category is suppressed");
  assert.ok(families.includes("other"), "folded into other");
  const other = snap.by_category.find((c) => c.family === "other")!;
  assert.equal(other.agent_count, 1);
});

test("p6 commons: outstanding shares sum to ~100% and benchmark rows are flat", () => {
  const l = new Ledger();
  l.pool.deposit_liquidity(cspr(10000), "lp1");
  for (let i = 0; i < 3; i++) {
    seed(l, `inf${i}`, "inference.llm");
    l.pool.open_credit_line({ agent_id: `inf${i}`, max_credit: cspr(100), interest_rate_bps: 1000, term_seconds: 2592000 });
    l.pool.draw(`inf${i}`, cspr(30));
  }
  const commons = new CreditDataCommons(l);
  const snap = commons.snapshot();
  const totalShare = snap.by_category.reduce((s, c) => s + c.outstanding_share_bps, 0);
  assert.ok(totalShare >= 9900 && totalShare <= 10000, `shares ~100% (got ${totalShare})`);
  const rows = commons.categoryBenchmarkRows();
  assert.ok(rows.every((r) => "family" in r && "avg_reputation" in r && !("agent_id" in r)));
});

test("p6 commons: dispute slash rate is reported in the aggregate", () => {
  const l = new Ledger();
  for (let i = 0; i < 3; i++) seed(l, `a${i}`, "data.market");
  const d1 = l.disputes.open({ dispute_type: "fake_receipt", complainant: "a0", respondent_agent: "a1", note: "n", evidence_hash: "0x" });
  const d2 = l.disputes.open({ dispute_type: "fake_receipt", complainant: "a0", respondent_agent: "a2", note: "n", evidence_hash: "0x" });
  l.disputes.issue_verdict(d1.dispute_id, "agent_loses", cspr(5), ["bad"]);
  l.disputes.issue_verdict(d2.dispute_id, "agent_wins", 0n, ["ok"]);

  const snap = new CreditDataCommons(l).snapshot();
  assert.equal(snap.disputes.total, 2);
  assert.equal(snap.disputes.resolved, 2);
  assert.equal(snap.disputes.slash_rate_bps, 5000, "1 of 2 resolved carried a slash");
});
