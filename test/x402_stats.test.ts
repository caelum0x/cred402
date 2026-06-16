import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { cspr } from "../lib/core/units.js";
import { buildX402Stats } from "../lib/services/x402_stats.js";

function pay(l: Ledger, payer: string, seller: string, amount: bigint, n: number) {
  l.receipts.record_receipt({
    payer_agent: payer,
    seller_agent: seller,
    service_type: "weather_risk",
    amount,
    rwa_reference_hash: "0xr",
    result_hash: `0x${n}`,
    payment_proof_hash: `0xp${n}`,
    nonce: `n${n}`,
    expires_at: l.clock.now() + 300,
  });
}

test("x402 stats: empty network is zeroed", () => {
  const s = buildX402Stats(new Ledger());
  assert.equal(s.total_receipts, 0);
  assert.equal(s.total_volume_motes, "0");
  assert.equal(s.finalization_rate, 0);
});

test("x402 stats: aggregates volume, top counterparties and per-service", () => {
  const l = new Ledger();
  pay(l, "Buyer", "TopSeller", cspr(5), 1);
  pay(l, "Buyer", "TopSeller", cspr(3), 2);
  pay(l, "Buyer2", "SmallSeller", cspr(1), 3);

  const s = buildX402Stats(l);
  assert.equal(s.total_receipts, 3);
  assert.equal(s.total_volume_motes, cspr(9).toString());
  assert.equal(s.avg_receipt_motes, cspr(3).toString());
  // top seller by volume
  assert.equal(s.top_sellers[0]!.agent_id, "TopSeller");
  assert.equal(s.top_sellers[0]!.volume_motes, cspr(8).toString());
  // top payer
  assert.equal(s.top_payers[0]!.agent_id, "Buyer");
  // by service
  const weather = s.by_service.find((x) => x.service_type === "weather_risk")!;
  assert.equal(weather.receipts, 3);
});
