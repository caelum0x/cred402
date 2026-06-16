import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { buildReputationMovers } from "../lib/services/reputation_movers.js";

function reg(l: Ledger, id: string) {
  l.agents.register_agent({ agent_id: id, owner_public_key: "01", agent_public_key: "01", service_type: "monitoring" });
}

test("movers: separates net gainers from net losers, ranked by magnitude", () => {
  const l = new Ledger();
  reg(l, "Riser");
  reg(l, "Faller");
  reg(l, "BigRiser");

  l.agents.update_reputation("Riser", 10, "0x1"); // 70 → 80
  l.agents.update_reputation("Faller", -25, "0x2"); // 70 → 45
  l.agents.update_reputation("BigRiser", 20, "0x3"); // 70 → 90

  const m = buildReputationMovers(l, 5);
  assert.equal(m.gainers[0]!.agent_id, "BigRiser"); // biggest gain first
  assert.equal(m.gainers[0]!.change, 20);
  assert.equal(m.gainers[1]!.agent_id, "Riser");
  assert.equal(m.losers[0]!.agent_id, "Faller");
  assert.equal(m.losers[0]!.change, -25);
});

test("movers: net change collapses multiple updates", () => {
  const l = new Ledger();
  reg(l, "Volatile");
  l.agents.update_reputation("Volatile", 10, "0x1"); // 70 → 80
  l.agents.update_reputation("Volatile", -5, "0x2"); // 80 → 75
  const m = buildReputationMovers(l, 5);
  const v = m.gainers.find((x) => x.agent_id === "Volatile")!;
  assert.equal(v.change, 5); // net 70 → 75
  assert.equal(v.events, 2);
});

test("movers: respects the limit", () => {
  const l = new Ledger();
  for (let i = 0; i < 8; i++) {
    reg(l, `A${i}`);
    l.agents.update_reputation(`A${i}`, i + 1, "0x");
  }
  const m = buildReputationMovers(l, 3);
  assert.ok(m.gainers.length <= 3);
});
