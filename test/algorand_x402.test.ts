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
import {
  decodePaymentRequiredHeader,
  encodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from "@x402/avm";
import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
import {
  ALGORAND_CREDIT_SCORE_ROUTE,
  ALGORAND_X402_STATUS_ROUTE,
  AlgorandCreditScoreGateway,
  X402_CHALLENGE_TAG,
  algorandX402PrivateResponseHeaders,
  createX402HttpContext,
  describeAlgorandX402,
  loadAlgorandX402Config,
} from "../lib/x402/algorand_gateway.js";
import {
  inspectAlgorandChallenge,
  paymentConfirmationPhrase,
  readAndInspectAlgorandChallenge,
  selectSafeAlgorandAcceptance,
} from "../lib/x402/algorand_client.js";
import { loadAlgorandClientCliConfig } from "../scripts/algorand_x402_cli.js";
import {
  algorandDeploymentStatusUrl,
  assertAlgorandDeploymentStatus,
} from "../lib/x402/algorand_release.js";
import { ServerState } from "../api/state.js";

const VALID_ADDRESS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

class FakeFacilitator implements FacilitatorClient {
  supportedCalls = 0;
  verifyCalls = 0;
  settleCalls = 0;

  constructor(private readonly network: typeof ALGORAND_TESTNET_CAIP2 | typeof ALGORAND_MAINNET_CAIP2) {}

  async getSupported(): Promise<SupportedResponse> {
    this.supportedCalls++;
    return {
      kinds: [{ x402Version: 2, scheme: "exact", network: this.network }],
      extensions: ["bazaar"],
      signers: {},
    };
  }

  async verify(_payload: PaymentPayload, _requirements: PaymentRequirements): Promise<VerifyResponse> {
    this.verifyCalls++;
    return { isValid: true, payer: VALID_ADDRESS };
  }

  async settle(_payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settleCalls++;
    return {
      success: true,
      payer: VALID_ADDRESS,
      transaction: "ALGO_TEST_TRANSACTION",
      network: requirements.network,
      amount: requirements.amount,
    };
  }
}

function config(network: "testnet" | "mainnet" = "testnet") {
  const loaded = loadAlgorandX402Config({
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_NETWORK: network,
    ...(network === "mainnet" ? {
      CRED402_ENV: "mainnet",
      CRED402_PUBLIC_URL: "https://cred402.example",
      CRED402_DATA_DIR: "/tmp/cred402-algorand-test",
      CRED402_ALGORAND_MAINNET_RELEASE_ACK: "I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS",
    } : {}),
  });
  if (!loaded.enabled) throw new Error(loaded.reason);
  assert.equal(loaded.enabled, true);
  return loaded.config;
}

function request(paymentSignature?: string) {
  return createX402HttpContext({
    method: "GET",
    path: "/v1/x402/credit-score/InferenceAgent",
    url: "https://cred402.example/v1/x402/credit-score/InferenceAgent",
    headers: paymentSignature ? { "payment-signature": paymentSignature } : {},
  });
}

test("Algorand config is fail-closed without a real pay-to address", () => {
  const missing = loadAlgorandX402Config({});
  assert.equal(missing.enabled, false);
  if (!missing.enabled) assert.match(missing.reason, /PAY_TO/);

  const invalid = loadAlgorandX402Config({ CRED402_ALGORAND_PAY_TO: "placeholder" });
  assert.equal(invalid.enabled, false);
  if (!invalid.enabled) assert.match(invalid.reason, /valid Algorand address/);

  const unsafeMainnet = loadAlgorandX402Config({
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_NETWORK: "mainnet",
    CRED402_ENV: "mainnet",
    CRED402_DATA_DIR: "/tmp/cred402-algorand-test",
    CRED402_ALGORAND_MAINNET_RELEASE_ACK: "I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS",
    CRED402_PUBLIC_URL: "http://localhost:4021",
  });
  assert.equal(unsafeMainnet.enabled, false);
  if (!unsafeMainnet.enabled) assert.match(unsafeMainnet.reason, /HTTPS/);
});

test("Algorand production config pins safe HTTPS origins and bounded facilitator timeouts", () => {
  const missingProductionOrigin = loadAlgorandX402Config({
    NODE_ENV: "production",
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_NETWORK: "testnet",
    CRED402_DATA_DIR: "/tmp/cred402-algorand-test",
  });
  assert.equal(missingProductionOrigin.enabled, false);
  if (!missingProductionOrigin.enabled) assert.match(missingProductionOrigin.reason, /pinned HTTPS origin/);

  const credentialedFacilitator = loadAlgorandX402Config({
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_FACILITATOR_URL: "https://user:secret@facilitator.example",
  });
  assert.equal(credentialedFacilitator.enabled, false);
  if (!credentialedFacilitator.enabled) assert.match(credentialedFacilitator.reason, /without credentials/);

  const oversizedTimeout = loadAlgorandX402Config({
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_FACILITATOR_TIMEOUT_MS: "60001",
  });
  assert.equal(oversizedTimeout.enabled, false);
  if (!oversizedTimeout.enabled) assert.match(oversizedTimeout.reason, /1 to 60000/);

  const safeProduction = loadAlgorandX402Config({
    NODE_ENV: "production",
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_NETWORK: "testnet",
    CRED402_PUBLIC_URL: "https://cred402.example/path-is-normalized",
    CRED402_ALGORAND_FACILITATOR_URL: "https://facilitator.example/",
    CRED402_DATA_DIR: "/tmp/cred402-algorand-test",
  });
  assert.equal(safeProduction.enabled, true);
  if (safeProduction.enabled) {
    assert.equal(safeProduction.config.publicBaseUrl, "https://cred402.example");
    assert.equal(safeProduction.config.facilitatorUrl, "https://facilitator.example");
  }
});

test("Algorand config selects the correct CAIP-2 network and USDC ASA", () => {
  const testnet = config("testnet");
  assert.equal(testnet.network, ALGORAND_TESTNET_CAIP2);
  assert.equal(testnet.usdcAsset, USDC_TESTNET_ASA_ID);

  const mainnet = config("mainnet");
  assert.equal(mainnet.network, ALGORAND_MAINNET_CAIP2);
  assert.equal(mainnet.usdcAsset, USDC_MAINNET_ASA_ID);
});

test("public deployment status exposes complete configuration without secrets", () => {
  const disabled = describeAlgorandX402(loadAlgorandX402Config({}));
  assert.equal(disabled.configured, false);
  assert.match(disabled.reason!, /PAY_TO/);
  assert.equal(disabled.paid_route, ALGORAND_CREDIT_SCORE_ROUTE);

  const loaded = loadAlgorandX402Config({
    CRED402_ALGORAND_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_NETWORK: "mainnet",
    CRED402_ENV: "mainnet",
    CRED402_DATA_DIR: "/tmp/cred402-algorand-test",
    CRED402_ALGORAND_MAINNET_RELEASE_ACK: "I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS",
    CRED402_PUBLIC_URL: "https://cred402.example",
  });
  const status = describeAlgorandX402(loaded);
  assert.equal(status.configured, true);
  assert.equal(status.network, ALGORAND_MAINNET_CAIP2);
  assert.equal(status.usdc_asset, USDC_MAINNET_ASA_ID);
  assert.equal(status.pay_to, VALID_ADDRESS);
  assert.equal(status.public_origin, "https://cred402.example");
  assert.equal(
    algorandDeploymentStatusUrl("https://cred402.example/v1/x402/credit-score/Agent"),
    `https://cred402.example${ALGORAND_X402_STATUS_ROUTE}`,
  );
  assert.equal("client_private_key" in status, false);
});

test("paid credit responses cannot be cached or shared across payment signatures", () => {
  const headers = algorandX402PrivateResponseHeaders("req_test");
  assert.match(headers["Cache-Control"]!, /private/);
  assert.match(headers["Cache-Control"]!, /no-store/);
  assert.match(headers.Vary!, /PAYMENT-SIGNATURE/);
  assert.equal(headers["X-Request-Id"], "req_test");
});

test("unpaid credit-score request returns x402 v2 + Algorand USDC + Bazaar metadata", async () => {
  const cfg = config();
  const facilitator = new FakeFacilitator(cfg.network);
  const gateway = new AlgorandCreditScoreGateway(cfg, facilitator);
  const result = await gateway.authorize(request());

  assert.equal(result.type, "payment-error");
  if (result.type !== "payment-error") return;
  assert.equal(result.response.status, 402);
  const encoded = result.response.headers["PAYMENT-REQUIRED"];
  assert.ok(encoded);
  const paymentRequired = decodePaymentRequiredHeader(encoded!);
  assert.equal(paymentRequired.x402Version, 2);
  assert.equal(paymentRequired.accepts[0]!.network, ALGORAND_TESTNET_CAIP2);
  assert.equal(paymentRequired.accepts[0]!.asset, USDC_TESTNET_ASA_ID);
  assert.equal(paymentRequired.accepts[0]!.amount, "10000");
  assert.equal(paymentRequired.accepts[0]!.payTo, VALID_ADDRESS);
  assert.ok(paymentRequired.resource.tags?.includes("x402-global-challenge"));
  // The facilitator attributes challenge volume from accepts[].extra.tag at settlement
  // time; resource.tags is not persisted into the Bazaar record. Without this the
  // endpoint settles but never appears under SOURCE -> X402-GLOBAL-CHALLENGE.
  assert.equal(
    (paymentRequired.accepts[0]!.extra as Record<string, unknown> | undefined)?.tag,
    X402_CHALLENGE_TAG,
    "challenge tag must ride in accepts[].extra.tag for leaderboard attribution",
  );
  assert.ok(paymentRequired.extensions?.bazaar, "Bazaar discovery declaration is present");
  const merchant = paymentRequired.extensions?.["x402-merchant"] as
    | { info?: Record<string, unknown>; schema?: Record<string, unknown> }
    | undefined;
  assert.ok(merchant?.info?.name, "merchant identity extension declares a public name");
  assert.ok(merchant?.schema, "merchant identity extension declares its JSON schema");
  const bazaarValidation = validateDiscoveryExtensionSpec(
    paymentRequired.extensions!.bazaar as Record<string, unknown>,
  );
  assert.equal(bazaarValidation.valid, true, bazaarValidation.errors?.join("; "));
  const inspection = inspectAlgorandChallenge(paymentRequired, {
    networkName: "testnet",
    expectedPayTo: VALID_ADDRESS,
    expectedAmountMicroUsdc: "10000",
    maxAmountMicroUsdc: "10000",
    requestUrl: request().adapter.getUrl(),
  });
  assert.equal(inspection.amountUsdc, "0.01");
  assert.equal(
    paymentConfirmationPhrase(inspection),
    `PAY 0.01 USDC ON ALGORAND TESTNET TO ${VALID_ADDRESS}`,
  );
  const deploymentStatus = describeAlgorandX402({ enabled: true, config: cfg });
  assert.doesNotThrow(() => assertAlgorandDeploymentStatus(deploymentStatus, inspection));
  assert.throws(
    () => assertAlgorandDeploymentStatus(
      { ...deploymentStatus, price_micro_usdc: "10001" },
      inspection,
    ),
    /price mismatch/,
  );
  const decodedFromHttp = await readAndInspectAlgorandChallenge(
    new Response("payment required", {
      status: 402,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
    }),
    {
      networkName: "testnet",
      expectedPayTo: VALID_ADDRESS,
      expectedAmountMicroUsdc: "10000",
      maxAmountMicroUsdc: "10000",
      requestUrl: request().adapter.getUrl(),
    },
  );
  assert.equal(decodedFromHttp.selected, decodedFromHttp.paymentRequired.accepts[0]);
  assert.equal(facilitator.supportedCalls, 1);
});

test("payment selector fails closed on changed receiver, price, or alternatives", () => {
  const requirement: PaymentRequirements = {
    scheme: "exact",
    network: ALGORAND_TESTNET_CAIP2,
    asset: USDC_TESTNET_ASA_ID,
    amount: "10000",
    payTo: VALID_ADDRESS,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", decimals: 6 },
  };
  const policy = {
    networkName: "testnet" as const,
    expectedPayTo: VALID_ADDRESS,
    expectedAmountMicroUsdc: "10000",
    maxAmountMicroUsdc: "10000",
  };

  assert.equal(selectSafeAlgorandAcceptance(2, [requirement], policy), requirement);
  assert.throws(
    () => selectSafeAlgorandAcceptance(2, [{ ...requirement, payTo: "B".repeat(58) }], policy),
    /Unexpected pay-to/,
  );
  assert.throws(
    () => selectSafeAlgorandAcceptance(2, [{ ...requirement, amount: "10001" }], policy),
    /exceeds maximum/,
  );
  assert.throws(
    () => selectSafeAlgorandAcceptance(2, [requirement, requirement], policy),
    /exactly one payment option/,
  );
  assert.throws(
    () => selectSafeAlgorandAcceptance(2, [{ ...requirement, maxTimeoutSeconds: 301 }], policy),
    /Unsafe payment timeout/,
  );
});

test("client config requires a pinned receiver and HTTPS for mainnet", () => {
  assert.throws(
    () => loadAlgorandClientCliConfig(["http://localhost:4021/paid"], {}),
    /EXPECTED_PAY_TO/,
  );
  assert.throws(
    () => loadAlgorandClientCliConfig(["http://localhost:4021/paid", "--mainnet"], {
      CRED402_ALGORAND_EXPECTED_PAY_TO: VALID_ADDRESS,
    }),
    /HTTPS/,
  );

  const loaded = loadAlgorandClientCliConfig(["https://cred402.example/paid", "--mainnet"], {
    CRED402_ALGORAND_EXPECTED_PAY_TO: VALID_ADDRESS,
    CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC: "25000",
    CRED402_ALGORAND_MAX_PRICE_MICRO_USDC: "30000",
  });
  assert.equal(loaded.policy.networkName, "mainnet");
  assert.equal(loaded.policy.expectedAmountMicroUsdc, "25000");
  assert.equal(loaded.policy.maxAmountMicroUsdc, "30000");
});

test("verified request settles once and returns a PAYMENT-RESPONSE header", async () => {
  const cfg = config();
  const facilitator = new FakeFacilitator(cfg.network);
  const gateway = new AlgorandCreditScoreGateway(cfg, facilitator);

  const unpaid = await gateway.authorize(request());
  assert.equal(unpaid.type, "payment-error");
  if (unpaid.type !== "payment-error") return;
  const paymentRequired = decodePaymentRequiredHeader(unpaid.response.headers["PAYMENT-REQUIRED"]!);
  const payload: PaymentPayload = {
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: paymentRequired.accepts[0]!,
    payload: { paymentGroup: ["test-only"], paymentIndex: 0 },
  };

  const paidContext = request(encodePaymentSignatureHeader(payload));
  const authorized = await gateway.authorize(paidContext);
  assert.equal(authorized.type, "payment-verified");
  if (authorized.type !== "payment-verified") return;

  const settled = await gateway.settle(authorized, paidContext, Buffer.from("{}"));
  assert.equal(settled.success, true);
  assert.equal(settled.transaction, "ALGO_TEST_TRANSACTION");
  assert.ok(settled.headers["PAYMENT-RESPONSE"]);
  assert.equal(facilitator.supportedCalls, 1, "facilitator capabilities are cached");
  assert.equal(facilitator.verifyCalls, 1);
  assert.equal(facilitator.settleCalls, 1);
});

test("paid report composes the existing oracle, risk model, and verified revenue", () => {
  const state = new ServerState();
  const agentId = state.economy.seller.agent_id;
  const report = state.x402CreditScore(agentId);
  assert.ok(!("error" in report));
  if ("error" in report) return;

  assert.equal(report.schema_version, "cred402.credit-score.v1");
  assert.equal(report.agent_id, agentId);
  assert.ok(report.score >= 0 && report.score <= 100);
  assert.ok(report.probability_of_default >= 0 && report.probability_of_default <= 1);
  assert.equal(report.provenance.model, "risk-engine-v2");
  assert.ok(Number.isInteger(report.x402_revenue.receipt_count));
  // The bootstrap seller is seeded demo data — the report must say so honestly.
  assert.equal(report.demo, true);
  assert.equal(report.data_source, "seeded_demo");
  assert.equal(report.x402_revenue.data_source, "seeded_demo");
  assert.equal(report.provenance.ledger_mode, "simulation");
  assert.match(report.provenance.disclaimer, /SEEDED DEMO/);
});
