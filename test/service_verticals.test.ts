import { test } from "node:test";
import assert from "node:assert/strict";
import { ServiceVerticals, SEED_VERTICAL_PROFILES } from "../lib/services/service_verticals.js";
import { cspr } from "../lib/core/units.js";

/**
 * Roadmap p10 — service verticals. Each major x402 family is a first-class credit
 * vertical with its own underwriting profile (advance rate, volatility haircut,
 * track-record + attestation gates).
 */

test("p10: every category family has a seeded vertical profile", () => {
  assert.equal(ServiceVerticals.coversCategoryFamilies(), true);
  // riskier families advance less than safer ones
  const v = new ServiceVerticals();
  assert.ok(v.get("rwa")!.advance_rate_bps > v.get("defi")!.advance_rate_bps);
  assert.equal(v.get("inference")!.risk_band, "elevated");
});

test("p10: profileFor resolves a concrete service type to its vertical", () => {
  const v = new ServiceVerticals();
  assert.equal(v.profileFor("inference.llm")!.vertical, "inference");
  assert.equal(v.profileFor("compute.gpu")!.vertical, "compute");
  assert.equal(v.isSupported("data.market"), true);
});

test("p10: qualify gates on required attestations and track record", () => {
  const v = new ServiceVerticals();
  // compute requires proof_of_compute and 25 jobs
  const tooNew = v.qualify("compute.gpu", { track_record_jobs: 5, attestations: ["proof_of_compute"] });
  assert.equal(tooNew.eligible, false);
  assert.equal(tooNew.track_record_shortfall, 20);

  const noAttestation = v.qualify("compute.gpu", { track_record_jobs: 30, attestations: [] });
  assert.equal(noAttestation.eligible, false);
  assert.deepEqual(noAttestation.missing_attestations, ["proof_of_compute"]);

  const ok = v.qualify("compute.gpu", { track_record_jobs: 30, attestations: ["proof_of_compute"] });
  assert.equal(ok.eligible, true);
  assert.equal(ok.missing_attestations.length, 0);
});

test("p10: sizeAdvance applies advance rate then a volatility haircut", () => {
  const v = new ServiceVerticals();
  const sizing = v.sizeAdvance("inference.llm", cspr(1000));
  // inference: 5000 bps advance, 2500 bps volatility haircut
  // 1000 * 0.50 = 500, * (1 - 0.25) = 375 CSPR
  assert.equal(sizing.advance_motes, cspr(375).toString());
  assert.equal(sizing.advance_rate_bps, 5000);
  assert.equal(sizing.volatility_haircut_bps, 2500);

  // a safer vertical advances more on the same revenue
  const rwa = v.sizeAdvance("rwa.weather_risk", cspr(1000));
  assert.ok(BigInt(rwa.advance_motes) > BigInt(sizing.advance_motes));
});

test("p10: unsupported vertical and zero revenue size to zero, no throw", () => {
  const v = new ServiceVerticals();
  assert.equal(v.sizeAdvance("data.market", 0n).advance_motes, "0");
  const unknown = v.sizeAdvance("teleportation.quantum", cspr(100));
  assert.equal(unknown.advance_motes, "0");
  assert.equal(v.isSupported("teleportation.quantum"), false);
});

test("p10: governance can register/tune a vertical profile; out-of-range rejected", () => {
  const v = new ServiceVerticals();
  v.register({ ...v.get("data")!, advance_rate_bps: 7500 });
  assert.equal(v.get("data")!.advance_rate_bps, 7500);
  assert.throws(() => v.register({ ...v.get("data")!, advance_rate_bps: 20000 }), /out of range/);
});

test("p10: list is sorted by advance rate and is a defensive copy", () => {
  const v = new ServiceVerticals();
  const list = v.list();
  for (let i = 1; i < list.length; i++) assert.ok(list[i - 1]!.advance_rate_bps >= list[i]!.advance_rate_bps);
  list[0]!.advance_rate_bps = -999; // mutating the copy must not affect the registry
  assert.ok(v.list()[0]!.advance_rate_bps >= 0);
  assert.equal(list.length, SEED_VERTICAL_PROFILES.length);
});
