import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { CrossChainReconciler } from "../lib/services/crosschain_reconciliation.js";

/**
 * Roadmap p5 — Omnichain credit. An agent's credit is authorized on Casper
 * (GlobalExposureManager = single source of truth) but drawn on satellites.
 * Reconciliation ties satellite reports back to Casper and flags the over-borrow
 * failure mode the multichain design exists to prevent.
 */

const USD = 1_000_000n; // normalized USD micro-units, the exposure manager's unit

function seed(l: Ledger, id: string, max_allowed: bigint) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01a", agent_public_key: "01b", service_type: "data.market" });
  l.exposure.ensure_agent(id, max_allowed);
}

function issueAndDraw(l: Ledger, id: string, chain: string, draw: bigint) {
  const note = l.notes.issue_can({
    agent_id: id,
    credit_score: 80,
    risk_policy_version: 2,
    target_chain: chain,
    target_pool: "0xpool",
    max_draw: draw,
    asset: "USDC",
  });
  l.notes.consume_can(note.note_id, draw); // satellite confirms the draw
  return note;
}

test("p5: a satellite report matching Casper outstanding reconciles clean", () => {
  const l = new Ledger();
  seed(l, "A", 1000n * USD);
  issueAndDraw(l, "A", "eip155:8453", 300n * USD);

  const r = new CrossChainReconciler(l).reconcile("A", [{ chain: "eip155:8453", outstanding: 300n * USD }]);
  assert.equal(r.consistent, true, r.alerts.join("; "));
  assert.equal(r.casper_outstanding, (300n * USD).toString());
  assert.equal(r.satellite_outstanding, (300n * USD).toString());
  assert.equal(r.discrepancy, "0");
  assert.equal(r.over_cap, false);
  assert.equal(r.global_headroom, (700n * USD).toString());
  assert.equal(r.chains.find((c) => c.chain === "eip155:8453")?.credit_notes, 1);
});

test("p5: a satellite over-reporting its draw is flagged as a discrepancy", () => {
  const l = new Ledger();
  seed(l, "A", 1000n * USD);
  issueAndDraw(l, "A", "eip155:8453", 300n * USD);

  // satellite claims 500 outstanding but Casper only authorized/activated 300
  const r = new CrossChainReconciler(l).reconcile("A", [{ chain: "eip155:8453", outstanding: 500n * USD }]);
  assert.equal(r.consistent, false);
  assert.equal(r.discrepancy, (200n * USD).toString());
  assert.ok(r.alerts.some((a) => /over-reports/.test(a)), r.alerts.join("; "));
});

test("p5: satellite credit with no authorizing CAN is flagged unauthorized", () => {
  const l = new Ledger();
  seed(l, "A", 1000n * USD);
  // no CAN issued for Solana, yet a satellite reports a draw there
  const r = new CrossChainReconciler(l).reconcile("A", [{ chain: "solana:mainnet", outstanding: 50n * USD }]);
  const solana = r.chains.find((c) => c.chain === "solana:mainnet");
  assert.equal(solana?.unauthorized, true);
  assert.equal(r.consistent, false);
  assert.ok(r.alerts.some((a) => /no authorizing CAN/.test(a)));
});

test("p5: globalHeadroom is the remaining draw across all chains", () => {
  const l = new Ledger();
  seed(l, "A", 1000n * USD);
  const recon = new CrossChainReconciler(l);
  assert.equal(recon.globalHeadroom("A"), 1000n * USD);

  // reserve 400 (CAN issued, not yet drawn) => headroom drops to 600
  l.notes.issue_can({
    agent_id: "A", credit_score: 80, risk_policy_version: 2,
    target_chain: "eip155:8453", target_pool: "0xpool", max_draw: 400n * USD, asset: "USDC",
  });
  assert.equal(recon.globalHeadroom("A"), 600n * USD);
  assert.equal(recon.globalHeadroom("ghost"), 0n);
});

test("p5: a frozen agent with outstanding debt is inconsistent", () => {
  const l = new Ledger();
  seed(l, "A", 1000n * USD);
  issueAndDraw(l, "A", "eip155:8453", 200n * USD);
  l.exposure.freeze_agent_exposure("A");

  const r = new CrossChainReconciler(l).reconcile("A", [{ chain: "eip155:8453", outstanding: 200n * USD }]);
  assert.equal(r.frozen, true);
  assert.equal(r.consistent, false);
  assert.ok(r.alerts.some((a) => /frozen/.test(a)));
});

test("p5: reconcileAll surfaces inconsistent agents first", () => {
  const l = new Ledger();
  seed(l, "Good", 1000n * USD);
  seed(l, "Bad", 1000n * USD);
  issueAndDraw(l, "Good", "eip155:8453", 100n * USD);
  issueAndDraw(l, "Bad", "eip155:8453", 100n * USD);

  const all = new CrossChainReconciler(l).reconcileAll({
    Good: [{ chain: "eip155:8453", outstanding: 100n * USD }],
    Bad: [{ chain: "eip155:8453", outstanding: 999n * USD }], // wildly over-reports
  });
  assert.equal(all.length, 2);
  assert.equal(all[0]!.agent_id, "Bad", "inconsistent agent sorts first");
  assert.equal(all[0]!.consistent, false);
  assert.equal(all[1]!.consistent, true);
});

test("p5: no exposure record + satellite debt is an unauthorized inconsistency", () => {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "Z", owner_public_key: "01a", agent_public_key: "01b", service_type: "data.market" });
  const r = new CrossChainReconciler(l).reconcile("Z", [{ chain: "eip155:8453", outstanding: 10n * USD }]);
  assert.equal(r.has_exposure, false);
  assert.equal(r.consistent, false);
  assert.ok(r.alerts.some((a) => /no Casper exposure/.test(a)));
});
