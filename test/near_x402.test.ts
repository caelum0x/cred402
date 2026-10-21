import { test } from "node:test";
import assert from "node:assert/strict";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import {
  NEAR_MAINNET_NETWORK,
  NEAR_TESTNET_NETWORK,
  isValidNearAccountId,
  isValidNearHash,
  nearNetworkNameFor,
} from "../lib/x402/near_networks.js";
import {
  NEAR_CREDIT_SCORE_ROUTE,
  NEAR_X402_STATUS_ROUTE,
  NearCreditScoreGateway,
  createX402HttpContext,
  describeNearX402,
  loadNearX402Config,
  nearX402PrivateResponseHeaders,
} from "../lib/x402/near_gateway.js";
import { NearPaymentAttemptStore } from "../lib/x402/near_payment_attempt_store.js";
import { verifyNearAssetTransfer } from "../lib/x402/near_finality.js";

const PAY_TO = "cred402.testnet";
const PAYER = "buyer-agent.testnet";
const TX_HASH = "4BJRYfnu29GPWdksz7EMUbiqx5CKSZgov3AHQXemt18F";

function config(network: "testnet" | "mainnet" = "testnet") {
  const loaded = loadNearX402Config({
    CRED402_NEAR_PAY_TO: PAY_TO,
    CRED402_NEAR_NETWORK: network,
    ...(network === "mainnet" ? {
      CRED402_ENV: "mainnet",
      CRED402_PUBLIC_URL: "https://cred402.example",
      CRED402_DATA_DIR: "/tmp/cred402-near-test",
      CRED402_NEAR_RPC_URL: "https://mainnet-rpc.example",
      CRED402_NEAR_MAINNET_RELEASE_ACK: "I_ACKNOWLEDGE_REAL_NEAR_MAINNET_PAYMENTS",
    } : {}),
  });
  if (!loaded.enabled) throw new Error(loaded.reason);
  return loaded.config;
}

function request(paymentSignature?: string) {
  return createX402HttpContext({
    method: "GET",
    path: "/v1/x402/near/credit-score/InferenceAgent",
    url: "https://cred402.example/v1/x402/near/credit-score/InferenceAgent",
    headers: paymentSignature ? { "payment-signature": paymentSignature } : {},
  });
}

test("NEAR network ids resolve both directions and reject unknown values", () => {
  assert.equal(nearNetworkNameFor("testnet"), "testnet");
  assert.equal(nearNetworkNameFor(NEAR_MAINNET_NETWORK), "mainnet");
  assert.equal(nearNetworkNameFor(NEAR_TESTNET_NETWORK), "testnet");
  assert.equal(nearNetworkNameFor("nope"), undefined);
});

test("NEAR account id and transaction hash validators fail closed", () => {
  assert.equal(isValidNearAccountId("cred402.testnet"), true);
  assert.equal(isValidNearAccountId("a".repeat(64)), true);
  assert.equal(isValidNearAccountId(""), false);
  assert.equal(isValidNearAccountId("Not_Lowercase"), false);
  assert.equal(isValidNearAccountId("bad..account"), false);
  assert.equal(isValidNearHash(TX_HASH), true);
  assert.equal(isValidNearHash("not-base58!"), false);
});

test("NEAR config is fail-closed without a pay-to account", () => {
  const missingPayTo = loadNearX402Config({});
  assert.equal(missingPayTo.enabled, false);
  if (!missingPayTo.enabled) assert.match(missingPayTo.reason, /CRED402_NEAR_PAY_TO/);

  const invalidPayTo = loadNearX402Config({ CRED402_NEAR_PAY_TO: "NOT_VALID!" });
  assert.equal(invalidPayTo.enabled, false);
  if (!invalidPayTo.enabled) assert.match(invalidPayTo.reason, /valid NEAR account id/);

  const missingMainnetAck = loadNearX402Config({
    CRED402_NEAR_PAY_TO: PAY_TO,
    CRED402_NEAR_NETWORK: "mainnet",
    CRED402_ENV: "mainnet",
    CRED402_PUBLIC_URL: "https://cred402.example",
    CRED402_DATA_DIR: "/tmp/cred402-near-test",
    CRED402_NEAR_RPC_URL: "https://mainnet-rpc.example",
  });
  assert.equal(missingMainnetAck.enabled, false);
  if (!missingMainnetAck.enabled) assert.match(missingMainnetAck.reason, /CRED402_NEAR_MAINNET_RELEASE_ACK/);

  const safeTestnet = config("testnet");
  assert.equal(safeTestnet.network, NEAR_TESTNET_NETWORK);
  assert.equal(safeTestnet.rpcUrl, "https://rpc.testnet.near.org");

  const safeMainnet = config("mainnet");
  assert.equal(safeMainnet.network, NEAR_MAINNET_NETWORK);
});

test("public NEAR status exposes complete configuration without secrets and needs no facilitator", () => {
  const disabled = describeNearX402(loadNearX402Config({}));
  assert.equal(disabled.configured, false);
  assert.equal(disabled.paid_route, NEAR_CREDIT_SCORE_ROUTE);
  assert.equal(disabled.facilitator, "self-verified");

  const status = describeNearX402({ enabled: true, config: config("testnet") });
  assert.equal(status.configured, true);
  assert.equal(status.network, NEAR_TESTNET_NETWORK);
  assert.equal(status.pay_to, PAY_TO);
  assert.equal(status.paid_route, NEAR_CREDIT_SCORE_ROUTE);
  assert.equal(status.facilitator, "self-verified");
});

test("paid NEAR credit responses cannot be cached or shared across payment signatures", () => {
  const headers = nearX402PrivateResponseHeaders("req_test");
  assert.match(headers["Cache-Control"]!, /private/);
  assert.match(headers["Cache-Control"]!, /no-store/);
  assert.equal(headers["X-Request-Id"], "req_test");
});

test("unpaid NEAR credit-score request returns an x402 v2 challenge priced in native NEAR", async () => {
  const cfg = config();
  const gateway = new NearCreditScoreGateway(cfg);
  const result = await gateway.authorize(request());

  assert.equal(result.type, "payment-error");
  if (result.type !== "payment-error") return;
  assert.equal(result.response.status, 402);
  const encoded = result.response.headers["PAYMENT-REQUIRED"];
  assert.ok(encoded);
  const paymentRequired = decodePaymentRequiredHeader(encoded!);
  assert.equal(paymentRequired.x402Version, 2);
  assert.equal(paymentRequired.accepts[0]!.network, NEAR_TESTNET_NETWORK);
  assert.equal(paymentRequired.accepts[0]!.asset, "near-native");
  assert.equal(paymentRequired.accepts[0]!.amount, cfg.priceYocto);
  assert.equal(paymentRequired.accepts[0]!.payTo, PAY_TO);
});

test("NEAR gateway rejects a payment signature with the wrong receiver, asset, or amount", async () => {
  const cfg = config();
  const gateway = new NearCreditScoreGateway(cfg);
  const badReceiver = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: NEAR_TESTNET_NETWORK, asset: "near-native", amount: cfg.priceYocto, payTo: "someone-else.testnet", maxTimeoutSeconds: 60, extra: {} },
    payload: { signerId: PAYER, transaction: TX_HASH },
  });
  const rejected = await gateway.authorize(request(badReceiver));
  assert.equal(rejected.type, "payment-error");

  const lowAmount = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: NEAR_TESTNET_NETWORK, asset: "near-native", amount: "1", payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
    payload: { signerId: PAYER, transaction: TX_HASH },
  });
  const tooLow = await gateway.authorize(request(lowAmount));
  assert.equal(tooLow.type, "payment-error");

  const missingSigner = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: NEAR_TESTNET_NETWORK, asset: "near-native", amount: cfg.priceYocto, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
    payload: { transaction: TX_HASH },
  });
  const noSigner = await gateway.authorize(request(missingSigner));
  assert.equal(noSigner.type, "payment-error");
});

test("NEAR gateway accepts a well-formed payment signature and extracts payer + transaction", async () => {
  const cfg = config();
  const gateway = new NearCreditScoreGateway(cfg);
  const signature = encodePaymentSignatureHeader({
    x402Version: 2,
    accepted: { scheme: "exact", network: NEAR_TESTNET_NETWORK, asset: "near-native", amount: cfg.priceYocto, payTo: PAY_TO, maxTimeoutSeconds: 60, extra: {} },
    payload: { signerId: PAYER, transaction: TX_HASH },
  });
  const result = await gateway.authorize(request(signature));
  assert.equal(result.type, "payment-verified");
  if (result.type !== "payment-verified") return;
  assert.equal(result.payer, PAYER);
  assert.equal(result.transaction, TX_HASH);
});

test("NEAR payment attempt store is exact-once and replays the same resource response", () => {
  const store = new NearPaymentAttemptStore();
  const claim1 = store.claim({ paymentProofHash: "a".repeat(64), requestHash: "b".repeat(64), requestId: "req-1" });
  assert.equal(claim1.created, true);

  const claim2 = store.claim({ paymentProofHash: "a".repeat(64), requestHash: "b".repeat(64), requestId: "req-2" });
  assert.equal(claim2.created, false);
  assert.equal(claim2.attempt.attemptId, claim1.attempt.attemptId);

  const settled = store.settle("a".repeat(64), {
    network: NEAR_TESTNET_NETWORK,
    asset: "near-native",
    amountYocto: "10000000000000000000000",
    receiver: PAY_TO,
    transaction: TX_HASH,
    responseHeaders: {},
    resourceResponse: { ok: true },
  });
  assert.equal(settled.status, "settled");
  assert.deepEqual(store.getByAttemptId(settled.attemptId)?.settlement?.resourceResponse, { ok: true });
});

function fakeNearRpc(outcomes: {
  txStatus?: unknown;
  txBlockHeight?: number;
  finalHeight?: number;
}): typeof fetch {
  return (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string; params: Record<string, unknown> };
    if (body.method === "EXPERIMENTAL_tx_status") {
      if (outcomes.txStatus === null) return new Response(JSON.stringify({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" }, message: "doesn't exist" } }), { status: 200 });
      return new Response(JSON.stringify({ result: outcomes.txStatus }), { status: 200 });
    }
    if (body.method === "block") {
      const byHash = !("finality" in (body.params as object));
      const height = byHash ? outcomes.txBlockHeight : outcomes.finalHeight;
      return new Response(JSON.stringify({ result: { header: { height, hash: "block-hash" } } }), { status: 200 });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as typeof fetch;
}

test("NEAR finality confirms a matching Transfer action past the minimum finality depth", async () => {
  const fakeFetch = fakeNearRpc({
    txStatus: {
      status: { SuccessValue: "" },
      transaction: { signer_id: PAYER, receiver_id: PAY_TO, hash: TX_HASH, actions: [{ Transfer: { deposit: "10000000000000000000000" } }] },
      transaction_outcome: { block_hash: "tx-block-hash" },
    },
    txBlockHeight: 100,
    finalHeight: 101,
  });

  const result = await verifyNearAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumFinalityBlocks: 2, fetchFn: fakeFetch },
    { transaction: TX_HASH, payer: PAYER, receiver: PAY_TO, amountYocto: "10000000000000000000000" },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmations, 2);
});

test("NEAR finality reports pending when the transaction has not reached the minimum depth yet", async () => {
  const fakeFetch = fakeNearRpc({
    txStatus: {
      status: { SuccessValue: "" },
      transaction: { signer_id: PAYER, receiver_id: PAY_TO, hash: TX_HASH, actions: [{ Transfer: { deposit: "10000000000000000000000" } }] },
      transaction_outcome: { block_hash: "tx-block-hash" },
    },
    txBlockHeight: 100,
    finalHeight: 100,
  });

  const result = await verifyNearAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumFinalityBlocks: 2, fetchFn: fakeFetch },
    { transaction: TX_HASH, payer: PAYER, receiver: PAY_TO, amountYocto: "10000000000000000000000" },
  );
  assert.equal(result.status, "pending");
});

test("NEAR finality reports mismatch when the transfer amount is below the expected price", async () => {
  const fakeFetch = fakeNearRpc({
    txStatus: {
      status: { SuccessValue: "" },
      transaction: { signer_id: PAYER, receiver_id: PAY_TO, hash: TX_HASH, actions: [{ Transfer: { deposit: "1" } }] },
      transaction_outcome: { block_hash: "tx-block-hash" },
    },
    txBlockHeight: 100,
    finalHeight: 102,
  });

  const result = await verifyNearAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumFinalityBlocks: 2, fetchFn: fakeFetch },
    { transaction: TX_HASH, payer: PAYER, receiver: PAY_TO, amountYocto: "10000000000000000000000" },
  );
  assert.equal(result.status, "mismatch");
});

test("NEAR finality reports not_found when the configured RPC has not seen the transaction yet", async () => {
  const fakeFetch = fakeNearRpc({ txStatus: null });

  const result = await verifyNearAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumFinalityBlocks: 2, fetchFn: fakeFetch },
    { transaction: TX_HASH, payer: PAYER, receiver: PAY_TO, amountYocto: "10000000000000000000000" },
  );
  assert.equal(result.status, "not_found");
});

test("NEAR finality reports mismatch when the transaction failed on-chain", async () => {
  const fakeFetch = fakeNearRpc({
    txStatus: {
      status: { Failure: { ActionError: {} } },
      transaction: { signer_id: PAYER, receiver_id: PAY_TO, hash: TX_HASH, actions: [{ Transfer: { deposit: "10000000000000000000000" } }] },
      transaction_outcome: { block_hash: "tx-block-hash" },
    },
  });

  const result = await verifyNearAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumFinalityBlocks: 2, fetchFn: fakeFetch },
    { transaction: TX_HASH, payer: PAYER, receiver: PAY_TO, amountYocto: "10000000000000000000000" },
  );
  assert.equal(result.status, "mismatch");
});
