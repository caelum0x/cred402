import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Casper from "casper-js-sdk";
import { CasperSdkDeploySigner, toArgs } from "../lib/casper/sdk_signer.js";

const { PrivateKey, KeyAlgorithm } = Casper;
import { buildInstallDeploy } from "../lib/casper/install.js";
import { buildContractCall } from "../lib/casper/deploy.js";
import { arg } from "../lib/casper/args.js";

/**
 * p8 — the REAL Casper Testnet write path. These tests build and sign genuine,
 * byte-exact Casper deploys with casper-js-sdk entirely offline (no node), proving
 * the integration is real crypto, not a mock. Only signAndSubmit / installContract
 * touch the network — and that is exercised live when a funded key is present.
 */

function freshPem(): string {
  return PrivateKey.generate(KeyAlgorithm.ED25519).toPem();
}

test("p8 toArgs: maps every Cred402 CLType to a real CLValue", () => {
  const args = toArgs([
    arg.string("agent_id", "weather-risk-agent-01"),
    arg.bool("active", true),
    arg.u64("score", 92),
    arg.u512("amount", 5_000_000_000n),
    arg.publicKey("agent_public_key", "01" + "aa".repeat(32)),
    arg.key("contract", "1f".repeat(32)),
  ]);
  // Args.fromMap keyed by name — every one converted without throwing.
  assert.equal(args.args.size, 6);
  assert.ok(args.args.get("agent_id"));
  assert.ok(args.args.get("amount"));
});

test("p8 signer: builds a byte-exact, self-validating signed deploy (offline)", () => {
  const signer = new CasperSdkDeploySigner({
    secretKeyPem: freshPem(),
    nodeAddress: "https://node.testnet.casper.network/rpc",
  });
  const spec = buildContractCall({
    contractHash: "hash-" + "1f".repeat(32),
    entryPoint: "register_agent",
    args: [arg.string("agent_id", "weather-risk-agent-01"), arg.string("service_type", "rwa.weather_risk")],
    paymentMotes: 3_000_000_000n,
    chainName: "casper-test",
    sender: signer.publicKeyHex,
  });

  const deploy = signer.buildSignedDeploy(spec, new Date(1_700_000_000_000));
  assert.equal(deploy.validate(), true, "signed deploy must self-validate (real signature over real hash)");
  assert.match(deploy.hash.toHex(), /^[0-9a-f]{64}$/, "real 32-byte blake2b deploy hash");
  assert.equal(deploy.approvals.length, 1, "exactly one ed25519 approval");
  assert.equal(deploy.header.chainName, "casper-test");
});

test("p8 signer: deploy hash is deterministic in inputs (same ts → same hash)", () => {
  const pem = freshPem();
  const signer = new CasperSdkDeploySigner({ secretKeyPem: pem, nodeAddress: "https://x/rpc" });
  const spec = buildContractCall({
    contractHash: "hash-" + "ab".repeat(32),
    entryPoint: "set_credit_score",
    args: [arg.string("agent_id", "a1"), arg.u64("score", 80)],
    paymentMotes: 1_000_000_000n,
    chainName: "casper-test",
    sender: signer.publicKeyHex,
  });
  const ts = new Date(1_700_000_000_000);
  const h1 = signer.buildSignedDeploy(spec, ts).hash.toHex();
  const h2 = signer.buildSignedDeploy(spec, ts).hash.toHex();
  const h3 = signer.buildSignedDeploy(spec, new Date(1_700_000_001_000)).hash.toHex();
  assert.equal(h1, h2, "identical inputs+timestamp produce identical deploy hash");
  assert.notEqual(h1, h3, "a different timestamp changes the deploy hash");
});

test("p8 installer: builds a byte-exact WASM install deploy (offline)", () => {
  const wasmPath = join(tmpdir(), `cred402-test-${process.pid}.wasm`);
  // Deploy construction signs over the module bytes; any byte payload is valid
  // for build+sign (we are proving serialization/signature, not WASM execution).
  writeFileSync(wasmPath, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
  try {
    const { deploy, account } = buildInstallDeploy({
      wasmPath,
      paymentMotes: 120_000_000_000n,
      chainName: "casper-test",
      nodeAddress: "https://node.testnet.casper.network/rpc",
      secretKeyPem: freshPem(),
    });
    assert.equal(deploy.validate(), true);
    assert.match(account, /^01[0-9a-f]{64}$/, "ed25519 account public key hex");
    assert.ok(deploy.session.isModuleBytes?.() ?? deploy.session.moduleBytes, "session is ModuleBytes (installation)");
  } finally {
    rmSync(wasmPath, { force: true });
  }
});
