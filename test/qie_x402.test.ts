import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import {
  QIE_MAINNET_NETWORK,
  QIE_TESTNET_NETWORK,
  qieChainIdFor,
  qieHexChainIdFor,
  qieNetworkNameFor,
} from "../lib/x402/qie_networks.js";
import {
  QIE_CREDIT_SCORE_ROUTE,
  QIE_X402_STATUS_ROUTE,
  QieCreditScoreGateway,
  createX402HttpContext,
  describeQieX402,
  loadQieX402Config,
  qieX402PrivateResponseHeaders,
} from "../lib/x402/qie_gateway.js";
import {
  inspectQieChallenge,
  readAndInspectQieChallenge,
  selectSafeQieAcceptance,
} from "../lib/x402/qie_client.js";
import { QiePaymentAttemptStore } from "../lib/x402/qie_payment_attempt_store.js";
import { verifyQieAssetTransfer } from "../lib/x402/qie_finality.js";

const PAY_TO = "0x1111111111111111111111111111111111111111";
const ASSET = "0x2222222222222222222222222222222222222222";

class FakeFacilitator implements FacilitatorClient {
  supportedCalls = 0;
  verifyCalls = 0;
  settleCalls = 0;

  constructor(private readonly network: typeof QIE_TESTNET_NETWORK | typeof QIE_MAINNET_NETWORK) {}

  async getSupported(): Promise<SupportedResponse> {
    this.supportedCalls++;
    return { kinds: [{ x402Version: 2, scheme: "exact", network: this.network }], extensions: [], signers: {} };
  }

  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    return { isValid: true, payer: PAY_TO };
  }

  async settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    return { success: true, payer: PAY_TO, transaction: "0x" + "ab".repeat(32), network: requirements.network, amount: requirements.amount };
  }
}

function config(network: "testnet" | "mainnet" = "testnet") {
  const loaded = loadQieX402Config({
    CRED402_QIE_PAY_TO: PAY_TO,
    CRED402_QIE_ASSET_ADDRESS: ASSET,
    CRED402_QIE_FACILITATOR_URL: "https://facilitator.example",
    CRED402_QIE_NETWORK: network,
    ...(network === "mainnet" ? {
      CRED402_ENV: "mainnet",
      CRED402_PUBLIC_URL: "https://cred402.example",
      CRED402_DATA_DIR: "/tmp/cred402-qie-test",
      CRED402_QIE_RPC_URL: "https://mainnet-rpc.example",
      CRED402_QIE_MAINNET_RELEASE_ACK: "I_ACKNOWLEDGE_REAL_QUSDC_MAINNET_PAYMENTS",
    } : {}),
  });
  if (!loaded.enabled) throw new Error(loaded.reason);
  return loaded.config;
}

function request(paymentSignature?: string) {
  return createX402HttpContext({
    method: "GET",
    path: "/v1/x402/qie/credit-score/InferenceAgent",
    url: "https://cred402.example/v1/x402/qie/credit-score/InferenceAgent",
    headers: paymentSignature ? { "payment-signature": paymentSignature } : {},
  });
}

test("QIE network ids resolve both directions and reject unknown values", () => {
  assert.equal(qieNetworkNameFor("testnet"), "testnet");
  assert.equal(qieNetworkNameFor(QIE_MAINNET_NETWORK), "mainnet");
  assert.equal(qieNetworkNameFor("1990"), "mainnet");
  assert.equal(qieNetworkNameFor("nope"), undefined);
  assert.equal(qieChainIdFor("testnet"), 1983);
  assert.equal(qieHexChainIdFor("testnet"), "0x7bf");
  assert.equal(qieHexChainIdFor("mainnet"), "0x7c6");
});

test("QIE config is fail-closed without a pay-to address, asset contract, or facilitator", () => {
  const missingPayTo = loadQieX402Config({});
  assert.equal(missingPayTo.enabled, false);
  if (!missingPayTo.enabled) assert.match(missingPayTo.reason, /CRED402_QIE_PAY_TO/);

  const invalidPayTo = loadQieX402Config({ CRED402_QIE_PAY_TO: "not-an-address" });
  assert.equal(invalidPayTo.enabled, false);
  if (!invalidPayTo.enabled) assert.match(invalidPayTo.reason, /20-byte EVM address/);

  const missingAsset = loadQieX402Config({ CRED402_QIE_PAY_TO: PAY_TO });
  assert.equal(missingAsset.enabled, false);
  if (!missingAsset.enabled) assert.match(missingAsset.reason, /CRED402_QIE_ASSET_ADDRESS/);

  const missingFacilitator = loadQieX402Config({ CRED402_QIE_PAY_TO: PAY_TO, CRED402_QIE_ASSET_ADDRESS: ASSET });
  assert.equal(missingFacilitator.enabled, false);
  if (!missingFacilitator.enabled) assert.match(missingFacilitator.reason, /CRED402_QIE_FACILITATOR_URL/);

  const missingMainnetRpc = loadQieX402Config({
    CRED402_QIE_PAY_TO: PAY_TO,
    CRED402_QIE_ASSET_ADDRESS: ASSET,
    CRED402_QIE_FACILITATOR_URL: "https://facilitator.example",
    CRED402_QIE_NETWORK: "mainnet",
    CRED402_ENV: "mainnet",
    CRED402_PUBLIC_URL: "https://cred402.example",
    CRED402_DATA_DIR: "/tmp/cred402-qie-test",
    CRED402_QIE_MAINNET_RELEASE_ACK: "I_ACKNOWLEDGE_REAL_QUSDC_MAINNET_PAYMENTS",
  });
  assert.equal(missingMainnetRpc.enabled, false);
  if (!missingMainnetRpc.enabled) assert.match(missingMainnetRpc.reason, /CRED402_QIE_RPC_URL/);

  const safeTestnet = config("testnet");
  assert.equal(safeTestnet.network, QIE_TESTNET_NETWORK);
  assert.equal(safeTestnet.rpcUrl, "https://rpc1testnet.qie.digital/");

  const safeMainnet = config("mainnet");
  assert.equal(safeMainnet.network, QIE_MAINNET_NETWORK);
});

test("public QIE status exposes complete configuration without secrets", () => {
  const disabled = describeQieX402(loadQieX402Config({}));
  assert.equal(disabled.configured, false);
  assert.equal(disabled.paid_route, QIE_CREDIT_SCORE_ROUTE);

  const status = describeQieX402({ enabled: true, config: config("testnet") });
  assert.equal(status.configured, true);
  assert.equal(status.network, QIE_TESTNET_NETWORK);
  assert.equal(status.pay_to, PAY_TO);
  assert.equal(status.asset_address, ASSET);
  assert.equal(status.paid_route, QIE_CREDIT_SCORE_ROUTE);
});

test("paid credit responses cannot be cached or shared across payment signatures", () => {
  const headers = qieX402PrivateResponseHeaders("req_test");
  assert.match(headers["Cache-Control"]!, /private/);
  assert.match(headers["Cache-Control"]!, /no-store/);
  assert.equal(headers["X-Request-Id"], "req_test");
});

test("unpaid QIE credit-score request returns x402 v2 + the configured EVM asset", async () => {
  const cfg = config();
  const facilitator = new FakeFacilitator(cfg.network);
  const gateway = new QieCreditScoreGateway(cfg, facilitator);
  const result = await gateway.authorize(request());

  assert.equal(result.type, "payment-error");
  if (result.type !== "payment-error") return;
  assert.equal(result.response.status, 402);
  const encoded = result.response.headers["PAYMENT-REQUIRED"];
  assert.ok(encoded);
  const paymentRequired = decodePaymentRequiredHeader(encoded!);
  assert.equal(paymentRequired.x402Version, 2);
  assert.equal(paymentRequired.accepts[0]!.network, QIE_TESTNET_NETWORK);
  assert.equal(paymentRequired.accepts[0]!.asset, ASSET);
  assert.equal(paymentRequired.accepts[0]!.amount, "10000");
  assert.equal(paymentRequired.accepts[0]!.payTo, PAY_TO);

  const inspection = inspectQieChallenge(paymentRequired, {
    networkName: "testnet",
    expectedPayTo: PAY_TO,
    expectedAssetAddress: ASSET,
    expectedAmountBaseUnits: "10000",
    maxAmountBaseUnits: "10000",
    requestUrl: request().adapter.getUrl(),
  });
  assert.equal(inspection.amountBaseUnits, "10000");

  const decodedFromHttp = await readAndInspectQieChallenge(
    new Response("payment required", { status: 402, headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) } }),
    {
      networkName: "testnet",
      expectedPayTo: PAY_TO,
      expectedAssetAddress: ASSET,
      expectedAmountBaseUnits: "10000",
      maxAmountBaseUnits: "10000",
      requestUrl: request().adapter.getUrl(),
    },
  );
  assert.equal(decodedFromHttp.selected, decodedFromHttp.paymentRequired.accepts[0]);
  assert.equal(facilitator.supportedCalls, 1);
});

test("QIE payment selector fails closed on changed receiver, asset, price, or alternatives", () => {
  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: QIE_TESTNET_NETWORK,
    asset: ASSET,
    amount: "10000",
    payTo: PAY_TO,
    maxTimeoutSeconds: 60,
    extra: { name: "QUSDC", decimals: 6 },
  };
  const policy = {
    networkName: "testnet" as const,
    expectedPayTo: PAY_TO,
    expectedAssetAddress: ASSET,
    expectedAmountBaseUnits: "10000",
    maxAmountBaseUnits: "10000",
  };

  assert.equal(selectSafeQieAcceptance(2, [requirement], policy), requirement);
  assert.throws(() => selectSafeQieAcceptance(2, [{ ...requirement, payTo: "0x" + "9".repeat(40) }], policy), /Unexpected pay-to/);
  assert.throws(() => selectSafeQieAcceptance(2, [{ ...requirement, asset: "0x" + "8".repeat(40) }], policy), /Unexpected asset contract/);
  assert.throws(() => selectSafeQieAcceptance(2, [{ ...requirement, amount: "10001" }], policy), /exceeds maximum/);
  assert.throws(() => selectSafeQieAcceptance(2, [requirement, requirement], policy), /exactly one payment option/);
  assert.throws(() => selectSafeQieAcceptance(2, [{ ...requirement, maxTimeoutSeconds: 301 }], policy), /Unsafe payment timeout/);
});

test("QIE payment attempt store is exact-once and replays the same resource response", () => {
  const store = new QiePaymentAttemptStore();
  const claim1 = store.claim({ paymentProofHash: "a".repeat(64), requestHash: "b".repeat(64), requestId: "req-1" });
  assert.equal(claim1.created, true);

  const claim2 = store.claim({ paymentProofHash: "a".repeat(64), requestHash: "b".repeat(64), requestId: "req-2" });
  assert.equal(claim2.created, false);
  assert.equal(claim2.attempt.attemptId, claim1.attempt.attemptId);

  const settled = store.settle("a".repeat(64), {
    network: QIE_TESTNET_NETWORK,
    asset: ASSET,
    amountBaseUnits: "10000",
    receiver: PAY_TO,
    transaction: "0x" + "cd".repeat(32),
    responseHeaders: {},
    resourceResponse: { ok: true },
  });
  assert.equal(settled.status, "settled");
  assert.deepEqual(store.getByAttemptId(settled.attemptId)?.settlement?.resourceResponse, { ok: true });
});

test("QIE finality confirms a matching ERC-20 Transfer log past the minimum confirmation depth", async () => {
  const txHash = "0x" + "11".repeat(32);
  const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  const toTopic = `0x${"0".repeat(24)}${PAY_TO.slice(2)}`;
  const fromTopic = `0x${"0".repeat(24)}${"3".repeat(40)}`;

  const fakeFetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string };
    if (body.method === "eth_getTransactionReceipt") {
      return new Response(JSON.stringify({
        result: {
          transactionHash: txHash,
          status: "0x1",
          blockNumber: "0x64",
          from: "0x" + "3".repeat(40),
          to: ASSET,
          logs: [{ address: ASSET, topics: [transferTopic, fromTopic, toTopic], data: "0x2710" }],
        },
      }), { status: 200 });
    }
    if (body.method === "eth_blockNumber") {
      return new Response(JSON.stringify({ result: "0x65" }), { status: 200 });
    }
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as typeof fetch;

  const result = await verifyQieAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumConfirmations: 2, fetchFn: fakeFetch },
    { transaction: txHash, asset: ASSET, receiver: PAY_TO, amountBaseUnits: "10000" },
  );
  assert.equal(result.status, "confirmed");
  assert.equal(result.confirmations, 2);
});

test("QIE finality reports not_found when the configured RPC has not seen the transaction yet", async () => {
  const fakeFetch = (async (_url: unknown, init: unknown) => {
    const body = JSON.parse((init as { body: string }).body) as { method: string };
    if (body.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({ result: null }), { status: 200 });
    if (body.method === "eth_blockNumber") return new Response(JSON.stringify({ result: "0x65" }), { status: 200 });
    throw new Error(`unexpected RPC method ${body.method}`);
  }) as typeof fetch;

  const result = await verifyQieAssetTransfer(
    { rpcUrl: "https://rpc.example", timeoutMs: 1000, minimumConfirmations: 2, fetchFn: fakeFetch },
    { transaction: "0x" + "22".repeat(32), asset: ASSET, receiver: PAY_TO, amountBaseUnits: "10000" },
  );
  assert.equal(result.status, "not_found");
});
