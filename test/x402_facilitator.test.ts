import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CasperX402FacilitatorClient,
  facilitatorFromEnv,
  type ExactCasperPayload,
  type PaymentRequirements,
} from "../lib/x402/facilitator.js";

/**
 * p9 — real x402 facilitator client. Exercises the exact x402 V2 wire contract of
 * the make-software/casper-x402 facilitator (docs/api-reference.md) with an
 * injected fetch: request shaping, endpoint paths, and response parsing are real;
 * no live facilitator needed. Live wiring activates via CRED402_X402_FACILITATOR_URL.
 */

const payload: ExactCasperPayload = {
  x402Version: 2,
  scheme: "exact",
  network: "casper:casper-net-1",
  payload: {
    signature: "ab".repeat(65),
    publicKey: "01" + "cd".repeat(32),
    authorization: {
      from: "00" + "11".repeat(32),
      to: "00" + "22".repeat(32),
      value: "7500000000",
      validAfter: "1710000000",
      validBefore: "1710000900",
      nonce: "ef".repeat(32),
    },
  },
};

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "casper:casper-net-1",
  payTo: "00" + "22".repeat(32),
  amount: "7500000000",
  asset: "ab".repeat(32),
  extra: { name: "DemoUSD", version: "1", decimals: "9" },
  maxTimeoutSeconds: 900,
};

function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const { status = 200, body } = handler(String(input), init ?? {});
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("p9 facilitator: /verify posts the x402 V2 body and parses the verdict", async () => {
  let seenUrl = "";
  let seenBody: unknown;
  const client = new CasperX402FacilitatorClient({
    baseUrl: "http://localhost:4022/",
    fetchFn: stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init.body));
      return { body: { isValid: true, payer: payload.payload.authorization.from } };
    }),
  });
  const res = await client.verify(payload, requirements);
  assert.equal(seenUrl, "http://localhost:4022/verify", "trailing slash normalized, /verify path");
  assert.deepEqual((seenBody as { paymentPayload: unknown }).paymentPayload, payload);
  assert.deepEqual((seenBody as { paymentRequirements: unknown }).paymentRequirements, requirements);
  assert.equal(res.isValid, true);
  assert.equal(res.payer, payload.payload.authorization.from);
});

test("p9 facilitator: /settle returns the on-chain deploy hash on success", async () => {
  const client = new CasperX402FacilitatorClient({
    baseUrl: "http://localhost:4022",
    fetchFn: stubFetch((url) => {
      assert.equal(url, "http://localhost:4022/settle");
      return { body: { success: true, transaction: "9f".repeat(32), network: requirements.network, payer: "00abc" } };
    }),
  });
  const res = await client.settle(payload, requirements);
  assert.equal(res.success, true);
  assert.match(res.transaction, /^[0-9a-f]{64}$/);
});

test("p9 facilitator: surfaces business failure reasons (not thrown)", async () => {
  const client = new CasperX402FacilitatorClient({
    baseUrl: "http://localhost:4022",
    fetchFn: stubFetch(() => ({ body: { isValid: false, invalidReason: "amount_mismatch", invalidMessage: "value != amount" } })),
  });
  const res = await client.verify(payload, requirements);
  assert.equal(res.isValid, false);
  assert.equal(res.invalidReason, "amount_mismatch");
});

test("p9 facilitator: HTTP error becomes a typed X402FacilitatorError", async () => {
  const client = new CasperX402FacilitatorClient({
    baseUrl: "http://localhost:4022",
    fetchFn: stubFetch(() => ({ status: 500, body: { error: "boom" } })),
  });
  await assert.rejects(() => client.verify(payload, requirements), /HTTP 500/);
});

test("p9 facilitator: facilitatorFromEnv is null unless configured", () => {
  assert.equal(facilitatorFromEnv({}), null);
  assert.ok(facilitatorFromEnv({ CRED402_X402_FACILITATOR_URL: "http://localhost:4022" }));
});
