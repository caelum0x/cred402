import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  buildContractProvenance,
  buildContractHashes,
  SIMULATED_ONLY_CONTRACTS,
} from "../lib/ledger/contract_provenance.js";
import { Ledger } from "../lib/ledger/index.js";

interface TestnetManifest {
  chain: string;
  contracts: Array<{ name: string; contract_hash: string }>;
}

function realManifest(): TestnetManifest {
  return JSON.parse(readFileSync(resolve(process.cwd(), "deploys.testnet.json"), "utf8")) as TestnetManifest;
}

test("contract provenance: installed contracts carry their REAL Casper Testnet hash", () => {
  const provenance = buildContractProvenance();
  const manifest = realManifest();

  assert.equal(provenance.ledger_mode, "simulation");
  assert.equal(provenance.network, manifest.chain);

  for (const c of manifest.contracts) {
    const entry = provenance.contracts[c.name];
    assert.ok(entry, `missing provenance for installed contract ${c.name}`);
    assert.equal(entry.status, "installed");
    // The hash served to callers must be the REAL on-chain hash, not a synthetic
    // per-boot value — this is the core provenance-honesty guarantee.
    assert.equal(entry.contract_hash, c.contract_hash);
    assert.match(entry.contract_hash, /^hash-[0-9a-f]{64}$/);
    assert.ok(entry.explorer_url?.startsWith("https://"), "installed contracts link to cspr.live");
  }
});

test("contract provenance: simulation-only contracts are labeled, never disguised as on-chain", () => {
  const provenance = buildContractProvenance();
  for (const name of SIMULATED_ONLY_CONTRACTS) {
    const entry = provenance.contracts[name];
    assert.ok(entry, `missing provenance for simulated contract ${name}`);
    assert.equal(entry.status, "simulated");
    assert.equal(entry.network, null);
    // A simulated contract must NOT carry a `hash-` value that could be mistaken
    // for a real Casper package hash.
    assert.ok(!entry.contract_hash.startsWith("hash-"), `${name} must not look like an on-chain hash`);
    assert.ok(entry.contract_hash.startsWith("sim-"), `${name} must be clearly labeled simulated`);
    assert.equal(entry.explorer_url, undefined);
  }
});

test("contract provenance: the flat hash map is stable across boots (no synthetic per-boot hashes)", () => {
  const a = buildContractHashes();
  const b = buildContractHashes();
  assert.deepEqual(a, b, "hashes must be deterministic, not random per process");

  // A fresh Ledger must expose the same real hashes rather than minting new ones.
  const l1 = new Ledger();
  const l2 = new Ledger();
  assert.deepEqual(l1.contractHashes, l2.contractHashes);
  const manifest = realManifest();
  assert.equal(l1.contractHashes.AgentRegistry, manifest.contracts.find((c) => c.name === "AgentRegistry")!.contract_hash);
});

test("contract provenance: ledger snapshot advertises simulation mode + provenance", () => {
  const snapshot = new Ledger().snapshot() as {
    ledgerMode: string;
    contractProvenance: { ledger_mode: string; contracts: Record<string, unknown> };
  };
  assert.equal(snapshot.ledgerMode, "simulation");
  assert.equal(snapshot.contractProvenance.ledger_mode, "simulation");
  assert.ok(Object.keys(snapshot.contractProvenance.contracts).length >= 19);
});
