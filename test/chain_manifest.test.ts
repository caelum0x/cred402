import { test } from "node:test";
import assert from "node:assert/strict";

import {
  loadChainManifest,
  contractExplorerUrl,
  accountExplorerUrl,
} from "../lib/services/chain_manifest.js";
import { Ledger } from "../lib/ledger/index.js";
import { ExplorerService } from "../lib/services/explorer.js";

test("chain manifest: loads the real Casper Testnet deployment", () => {
  const m = loadChainManifest();
  assert.equal(m.chain, "casper-test");
  assert.equal(m.mode, "live");
  assert.ok(m.contract_count >= 14, "expected the full deployed contract set");
  assert.equal(m.contracts.length, m.contract_count);
  assert.ok(m.explorer.startsWith("https://"), "explorer base must be an absolute URL");
});

test("chain manifest: every contract gets a resolvable cspr.live link", () => {
  const m = loadChainManifest();
  for (const c of m.contracts) {
    assert.ok(c.name.length > 0);
    assert.match(c.contract_hash, /^hash-[0-9a-f]{64}$/, `bad hash for ${c.name}`);
    // The explorer URL must use the raw hex, with the CLType `hash-` prefix stripped.
    const hex = c.contract_hash.replace(/^hash-/, "");
    assert.equal(c.explorer_url, `${m.explorer}/contract/${hex}`);
    assert.ok(!c.explorer_url.includes("hash-"), "explorer URL must not keep the hash- prefix");
  }
});

test("chain manifest: deployer account links to its cspr.live page", () => {
  const m = loadChainManifest();
  assert.match(m.deployer_public_key, /^0[12][0-9a-f]+$/);
  assert.equal(m.deployer_url, `${m.explorer}/account/${m.deployer_public_key}`);
});

test("chain manifest: url builders normalise a trailing slash on the base", () => {
  assert.equal(
    contractExplorerUrl("https://x.io/", "hash-abcdef"),
    "https://x.io/contract/abcdef",
  );
  assert.equal(
    accountExplorerUrl("https://x.io", "01ff"),
    "https://x.io/account/01ff",
  );
});

test("chain manifest: repeated loads return a cached, stable manifest", () => {
  assert.deepEqual(loadChainManifest(), loadChainManifest());
});

test("explorer: resolves a deployed contract by name with a cspr.live link", () => {
  const results = new ExplorerService(new Ledger()).search("AgentRegistry");
  const contract = results.find((r) => r.kind === "contract");
  assert.ok(contract, "AgentRegistry should resolve as an on-chain contract");
  assert.ok(contract.url?.startsWith("https://testnet.cspr.live/contract/"));
  assert.ok(!contract.url?.includes("hash-"));
});

test("explorer: resolves a deployed contract by its on-chain hash", () => {
  const { contracts, explorer } = loadChainManifest();
  const target = contracts[0];
  assert.ok(target, "manifest must have at least one contract");
  const results = new ExplorerService(new Ledger()).search(target.contract_hash);
  const hit = results.find((r) => r.kind === "contract" && r.id === target.contract_hash);
  assert.ok(hit, "a full contract hash should resolve to its contract");
  assert.equal(hit.url, `${explorer}/contract/${target.contract_hash.replace(/^hash-/, "")}`);
});
