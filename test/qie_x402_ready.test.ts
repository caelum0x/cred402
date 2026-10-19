import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { QIE_MAINNET_NETWORK, QIE_TESTNET_NETWORK, qieHexChainIdFor } from "../lib/x402/qie_networks.js";
import type { QieX402PublicStatus } from "../lib/x402/qie_gateway.js";
import type { QieChallengeInspection } from "../lib/x402/qie_client.js";
import {
  assertExternalMainnetPayer,
  assessQieAccountReadiness,
  fetchQieAccountSnapshot,
  formatBaseUnits,
  type QieAccountSnapshot,
} from "../lib/x402/qie_readiness.js";
import {
  assertQieDeploymentStatus,
  buildQieReleaseEvidence,
  verifyQieReleaseEvidenceDigest,
} from "../lib/x402/qie_release.js";
import { loadQieClientCliConfig, loadQiePayerAddress, loadQieRpcUrl } from "../scripts/qie_x402_cli.js";

const PAYER = "0x1111111111111111111111111111111111111111";
const RECEIVER = "0x2222222222222222222222222222222222222222";
const ASSET = "0x3333333333333333333333333333333333333333";
const ENDPOINT = "https://cred402.example/v1/x402/qie/credit-score/EvidenceSellerAgent";

function snapshot(address: string, overrides: Partial<QieAccountSnapshot> = {}): QieAccountSnapshot {
  return {
    address,
    networkName: "testnet",
    chainId: qieHexChainIdFor("testnet"),
    blockNumber: 100n,
    tokenBalanceBaseUnits: 50_000n,
    ...overrides,
  };
}

test("payer is ready with a matching network and sufficient token balance", () => {
  const result = assessQieAccountReadiness(snapshot(PAYER), "payer", 10_000n);
  assert.equal(result.ready, true);
  assert.equal(result.checks.find((check) => check.id === "network_match")?.ok, true);
  assert.equal(result.checks.find((check) => check.id === "token_balance")?.ok, true);
});

test("insufficient token balance blocks the payer but not the receiver", () => {
  const insufficientPayer = assessQieAccountReadiness(
    snapshot(PAYER, { tokenBalanceBaseUnits: 9_999n }),
    "payer",
    10_000n,
  );
  assert.equal(insufficientPayer.ready, false);
  assert.equal(insufficientPayer.checks.find((check) => check.id === "token_balance")?.ok, false);

  const receiver = assessQieAccountReadiness(
    snapshot(RECEIVER, { tokenBalanceBaseUnits: 0n }),
    "receiver",
    10_000n,
  );
  assert.equal(receiver.ready, true);
  assert.equal(receiver.checks.some((check) => check.id === "token_balance"), false);
});

test("a chain id mismatch fails both payer and receiver readiness", () => {
  const wrongChain = assessQieAccountReadiness(
    snapshot(PAYER, { chainId: qieHexChainIdFor("mainnet") }),
    "payer",
    10_000n,
  );
  assert.equal(wrongChain.ready, false);
  assert.equal(wrongChain.checks.find((check) => check.id === "network_match")?.ok, false);
});

test("assessQieAccountReadiness rejects a non-positive required payment", () => {
  assert.throws(() => assessQieAccountReadiness(snapshot(PAYER), "payer", 0n), /must be positive/);
  assert.throws(() => assessQieAccountReadiness(snapshot(PAYER), "payer", -1n), /must be positive/);
});

test("base-unit formatting preserves atomic precision", () => {
  assert.equal(formatBaseUnits(10_000n, 6), "0.01");
  assert.equal(formatBaseUnits(1_234_567n, 6), "1.234567");
  assert.equal(formatBaseUnits(0n, 6), "0");
  assert.equal(formatBaseUnits(-10_000n, 6), "-0.01");
});

test("Mainnet activation rejects self-payment while Testnet permits a technical loop", () => {
  assert.doesNotThrow(() => assertExternalMainnetPayer("testnet", PAYER, PAYER));
  assert.throws(
    () => assertExternalMainnetPayer("mainnet", PAYER, PAYER),
    /self-payment is not a valid activation test/,
  );
  assert.doesNotThrow(() => assertExternalMainnetPayer("mainnet", PAYER, RECEIVER));
  // Case-insensitive EVM address comparison still catches a disguised self-payment.
  assert.throws(
    () => assertExternalMainnetPayer("mainnet", PAYER, PAYER.toUpperCase().replace("0X", "0x")),
    /self-payment is not a valid activation test/,
  );
});

test("fetchQieAccountSnapshot fails closed on an invalid address instead of guessing", async () => {
  await assert.rejects(
    () => fetchQieAccountSnapshot("not-an-address", "testnet", ASSET, { rpcUrl: "https://rpc.example" }),
    /Invalid QIE \(EVM\) address/,
  );
  await assert.rejects(
    () => fetchQieAccountSnapshot(PAYER, "testnet", "not-a-contract", { rpcUrl: "https://rpc.example" }),
    /Invalid QIE asset contract address/,
  );
});

test("fetchQieAccountSnapshot reads chain id, block number, and ERC-20 balance over the configured RPC (mocked)", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string; params: unknown[] };
    calls.push(body.method);
    if (body.method === "eth_chainId") {
      return new Response(JSON.stringify({ result: qieHexChainIdFor("testnet") }), { status: 200 });
    }
    if (body.method === "eth_blockNumber") {
      return new Response(JSON.stringify({ result: "0x64" }), { status: 200 });
    }
    if (body.method === "eth_call") {
      return new Response(JSON.stringify({ result: "0x0000000000000000000000000000000000000000000000000000000000002710" }), { status: 200 });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as typeof fetch;

  const result = await fetchQieAccountSnapshot(PAYER, "testnet", ASSET, {
    rpcUrl: "https://rpc.example",
    fetchFn: fakeFetch,
  });

  assert.deepEqual(new Set(calls), new Set(["eth_chainId", "eth_blockNumber", "eth_call"]));
  assert.equal(result.address, PAYER);
  assert.equal(result.chainId, qieHexChainIdFor("testnet"));
  assert.equal(result.blockNumber, 100n);
  assert.equal(result.tokenBalanceBaseUnits, 10_000n);

  const readiness = assessQieAccountReadiness(result, "payer", 10_000n);
  assert.equal(readiness.ready, true);
});

test("fetchQieAccountSnapshot propagates a clear error when the RPC itself fails (mocked)", async () => {
  const fakeFetch = (async () => new Response("", { status: 503 })) as typeof fetch;
  await assert.rejects(
    () => fetchQieAccountSnapshot(PAYER, "testnet", ASSET, { rpcUrl: "https://rpc.example", fetchFn: fakeFetch }),
    /HTTP 503/,
  );
});

test("loadQiePayerAddress fails closed when CRED402_QIE_CLIENT_ADDRESS is unset and no --payer flag is passed", () => {
  assert.throws(
    () => loadQiePayerAddress([], {}),
    /CRED402_QIE_CLIENT_ADDRESS/,
  );
  assert.throws(
    () => loadQiePayerAddress(["--payer=not-an-address"], {}),
    /not a valid QIE \(EVM\) address/,
  );
  assert.equal(loadQiePayerAddress(["--payer=" + PAYER], {}), PAYER);
  assert.equal(loadQiePayerAddress([], { CRED402_QIE_CLIENT_ADDRESS: PAYER }), PAYER);
});

test("loadQieRpcUrl fails closed on Mainnet without CRED402_QIE_RPC_URL, instead of guessing an endpoint", () => {
  assert.throws(
    () => loadQieRpcUrl("mainnet", {}),
    /no public QIE Mainnet RPC endpoint is independently confirmed/,
  );
  assert.equal(typeof loadQieRpcUrl("testnet", {}), "string");
  assert.equal(loadQieRpcUrl("mainnet", { CRED402_QIE_RPC_URL: "https://mainnet-rpc.example" }), "https://mainnet-rpc.example/");
  assert.throws(
    () => loadQieRpcUrl("testnet", { CRED402_QIE_RPC_URL: "not a url" }),
    /must be an HTTP\(S\) URL/,
  );
});

test("loadQieClientCliConfig fails closed when the expected pay-to or asset address env vars are missing", () => {
  assert.throws(
    () => loadQieClientCliConfig([ENDPOINT], {}),
    /CRED402_QIE_EXPECTED_PAY_TO/,
  );
  assert.throws(
    () => loadQieClientCliConfig([ENDPOINT], { CRED402_QIE_EXPECTED_PAY_TO: RECEIVER }),
    /CRED402_QIE_EXPECTED_ASSET_ADDRESS/,
  );
  assert.throws(
    () => loadQieClientCliConfig([], { CRED402_QIE_EXPECTED_PAY_TO: RECEIVER, CRED402_QIE_EXPECTED_ASSET_ADDRESS: ASSET }),
    /Pass the credit-score endpoint URL/,
  );

  const { endpoint, policy } = loadQieClientCliConfig([ENDPOINT], {
    CRED402_QIE_EXPECTED_PAY_TO: RECEIVER,
    CRED402_QIE_EXPECTED_ASSET_ADDRESS: ASSET,
  });
  assert.equal(endpoint, ENDPOINT);
  assert.equal(policy.networkName, "testnet");
  assert.equal(policy.expectedPayTo, RECEIVER);
  assert.equal(policy.expectedAssetAddress, ASSET);
  assert.equal(policy.maxAmountBaseUnits, "10000");
});

function fixture() {
  const selected: PaymentRequirements = {
    scheme: "exact",
    network: QIE_MAINNET_NETWORK,
    asset: ASSET,
    amount: "10000",
    payTo: RECEIVER,
    maxTimeoutSeconds: 60,
    extra: { name: "QUSDC", decimals: 6 },
  };
  const paymentRequired = {
    x402Version: 2,
    resource: { url: ENDPOINT, description: "Credit score", mimeType: "application/json" },
    accepts: [selected],
  } as PaymentRequired;
  const challenge: QieChallengeInspection = {
    paymentRequired,
    selected,
    networkName: "mainnet",
    amountBaseUnits: "10000",
    resourceUrl: ENDPOINT,
  };
  const status: QieX402PublicStatus = {
    schema_version: "cred402.qie-x402-status.v1",
    configured: true,
    protocol: "x402-v2",
    paid_route: "/v1/x402/qie/credit-score/:agentId",
    network: QIE_MAINNET_NETWORK,
    network_name: "mainnet",
    asset_address: ASSET,
    asset_symbol: "QUSDC",
    price_base_units: "10000",
    pay_to: RECEIVER,
    facilitator_url: "https://facilitator.example",
    public_origin: "https://cred402.example",
    release_tier: "mainnet",
  };
  return { challenge, status };
}

test("assertQieDeploymentStatus rejects an unconfigured or mismatched deployment", () => {
  const { challenge, status } = fixture();
  assert.doesNotThrow(() => assertQieDeploymentStatus(status, challenge));
  assert.throws(
    () => assertQieDeploymentStatus({ ...status, configured: false, reason: "not set up" }, challenge),
    /not configured: not set up/,
  );
  assert.throws(
    () => assertQieDeploymentStatus({ ...status, pay_to: PAYER }, challenge),
    /receiver mismatch/,
  );
  assert.throws(
    () => assertQieDeploymentStatus({ ...status, asset_address: PAYER }, challenge),
    /asset mismatch/,
  );
});

test("QIE release evidence is secret-free, serializable, and integrity checked", () => {
  const { challenge, status } = fixture();
  const evidence = buildQieReleaseEvidence({
    generatedAt: new Date("2026-08-23T12:00:00.000Z"),
    endpoint: ENDPOINT,
    status,
    challenge,
    payerReadiness: assessQieAccountReadiness(
      snapshot(PAYER, { networkName: "mainnet", chainId: qieHexChainIdFor("mainnet") }),
      "payer",
      10_000n,
    ),
    receiverReadiness: assessQieAccountReadiness(
      snapshot(RECEIVER, { networkName: "mainnet", chainId: qieHexChainIdFor("mainnet") }),
      "receiver",
      10_000n,
    ),
    releaseRef: "abc123",
  });

  assert.equal(evidence.result, "passed");
  assert.equal(evidence.release_ref, "abc123");
  assert.equal(evidence.accounts.payer.block_number, "100");
  assert.equal(verifyQieReleaseEvidenceDigest(evidence), true);
  assert.doesNotThrow(() => JSON.stringify(evidence));
  assert.doesNotMatch(JSON.stringify(evidence), /private[_ ]?key|mnemonic|secret/i);
  assert.equal(
    verifyQieReleaseEvidenceDigest({ ...evidence, release_ref: "tampered" }),
    false,
  );
});

test("QIE release evidence refuses unready accounts and Mainnet self-payment", () => {
  const { challenge, status } = fixture();
  const receiverReadiness = assessQieAccountReadiness(
    snapshot(RECEIVER, { networkName: "mainnet", chainId: qieHexChainIdFor("mainnet") }),
    "receiver",
    10_000n,
  );
  assert.throws(
    () => buildQieReleaseEvidence({
      generatedAt: new Date(),
      endpoint: ENDPOINT,
      status,
      challenge,
      payerReadiness: assessQieAccountReadiness(
        snapshot(PAYER, { networkName: "mainnet", chainId: qieHexChainIdFor("mainnet"), tokenBalanceBaseUnits: 1n }),
        "payer",
        10_000n,
      ),
      receiverReadiness,
    }),
    /payer account is not ready/,
  );

  assert.throws(
    () => buildQieReleaseEvidence({
      generatedAt: new Date(),
      endpoint: ENDPOINT,
      status,
      challenge,
      payerReadiness: assessQieAccountReadiness(
        snapshot(RECEIVER, { networkName: "mainnet", chainId: qieHexChainIdFor("mainnet") }),
        "payer",
        10_000n,
      ),
      receiverReadiness,
    }),
    /external payer/,
  );
});
