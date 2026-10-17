import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { cspr } from "../lib/core/units.js";

const TERM_SECONDS = 30 * 24 * 60 * 60; // 30-day line

function lineFor(maxCspr: number, drawnCspr: number) {
  const l = new Ledger();
  l.agents.register_agent({ agent_id: "A", owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
  l.pool.deposit_liquidity(cspr(10_000), "lp");
  l.pool.open_credit_line({
    agent_id: "A",
    max_credit: cspr(maxCspr),
    interest_rate_bps: 800,
    origination_fee_bps: 0,
    term_seconds: TERM_SECONDS,
  });
  if (drawnCspr > 0) l.pool.draw("A", cspr(drawnCspr));
  return l;
}

test("repay: full repayment resets the term to a fresh full-length window, not a shrunk remainder", () => {
  const l = lineFor(100, 50);
  const openedAt = l.pool.get("A")!.opened_at;

  // Let 10 of the 30 days elapse, then fully repay.
  l.clock.advance(10 * 24 * 60 * 60);
  const { line } = l.pool.repay("A", cspr(50) + 10_000_000_000n); // principal + generous interest overpay guard
  assert.equal(line.drawn, 0n);

  const now = l.clock.now();
  assert.equal(line.opened_at, now, "opened_at should reset to now");
  // The bug reused opened_at after it had already been overwritten, so the new
  // term became (old due_timestamp - now) instead of a full fresh term — i.e.
  // it was silently shrunk by however much of the original term had elapsed.
  assert.equal(
    line.due_timestamp - line.opened_at,
    TERM_SECONDS,
    "repayment must grant a full fresh term, not the old term minus elapsed time",
  );
  assert.ok(line.opened_at > openedAt);
});

test("repay: partial repayment does not touch the term window", () => {
  const l = lineFor(100, 50);
  const before = l.pool.get("A")!;
  l.clock.advance(5 * 24 * 60 * 60);
  const { line } = l.pool.repay("A", cspr(20));
  assert.ok(line.drawn > 0n, "still owes principal");
  assert.equal(line.opened_at, before.opened_at);
  assert.equal(line.due_timestamp, before.due_timestamp);
});
