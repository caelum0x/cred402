import { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { getState } from "./state.js";
import { json, sendInstructions } from "./http_utils.js";
import type { Gateway } from "../lib/gateway/index.js";
import { hashObject } from "../lib/core/hash.js";
import {
  NearCreditScoreGateway,
  NEAR_X402_STATUS_ROUTE,
  createX402HttpContext,
  describeNearX402,
  loadNearX402Config,
  nearX402PrivateResponseHeaders,
} from "../lib/x402/near_gateway.js";
import { NearPaymentAttemptStore } from "../lib/x402/near_payment_attempt_store.js";
import { verifyNearAssetTransfer } from "../lib/x402/near_finality.js";

/**
 * NEAR Hackathon (Nov 1-14, 2026) x402 paid credit-score domain.
 *
 * Structurally mirrors `algorand_x402_routes.ts` / `qie_x402_routes.ts`
 * (status probe, per-attempt reconciliation, paid credit-score settlement),
 * with the chain-specific piece swapped for NEAR: `NearCreditScoreGateway`
 * (a from-scratch `exact` scheme over `@x402/core`'s generic header codecs,
 * since no `@x402/near` package exists) instead of a facilitator-backed
 * gateway. There is no third-party facilitator for NEAR — Cred402 verifies
 * settlement itself against the configured NEAR RPC
 * (`verifyNearAssetTransfer`), the same role the independent finality
 * checks play for Algorand (Indexer) and QIE (RPC). `server.ts` delegates
 * to `handleNearX402` exactly like it already delegates to the other two.
 */

type State = ReturnType<typeof getState>;

const nearX402Config = loadNearX402Config();
const nearCreditScore = nearX402Config.enabled ? new NearCreditScoreGateway(nearX402Config.config) : undefined;
const nearPaymentAttempts = new NearPaymentAttemptStore(
  nearX402Config.enabled ? process.env.CRED402_DATA_DIR?.trim() : undefined,
);

async function reconcileNearPayment(state: State, paymentProofHash: string) {
  const attempt = nearPaymentAttempts.getByProofHash(paymentProofHash);
  if (!attempt?.settlement || !nearX402Config.enabled) return attempt;
  if (attempt.finality?.status === "confirmed" || attempt.finality?.status === "mismatch") return attempt;

  const { settlement } = attempt;
  if (!settlement.transaction) {
    if (settlement.externalReceiptId) {
      state.challengeNearExternalReceipt(settlement.externalReceiptId);
    }
    return nearPaymentAttempts.recordFinality(paymentProofHash, {
      status: "mismatch",
      checkedAt: new Date().toISOString(),
      reason: "Settlement is missing a transaction hash",
    });
  }

  const result = await verifyNearAssetTransfer(
    {
      rpcUrl: nearX402Config.config.rpcUrl,
      timeoutMs: nearX402Config.config.rpcTimeoutMs,
      minimumFinalityBlocks: nearX402Config.config.minimumFinalityBlocks,
    },
    {
      transaction: settlement.transaction,
      payer: settlement.payer,
      receiver: nearX402Config.config.payTo,
      amountYocto: settlement.amountYocto,
    },
  );
  const updated = nearPaymentAttempts.recordFinality(paymentProofHash, result);
  if (result.status === "confirmed" && settlement.externalReceiptId) {
    state.finalizeNearExternalReceipt(settlement.externalReceiptId);
  } else if (result.status === "mismatch" && settlement.externalReceiptId) {
    state.challengeNearExternalReceipt(settlement.externalReceiptId);
  }
  return updated;
}

async function respondUsage(res: ServerResponse): Promise<void> {
  if (!nearX402Config.enabled) {
    json(res, 503, {
      error: "near_x402_not_configured",
      message: nearX402Config.reason,
    }, { "Cache-Control": "no-store" });
    return;
  }
  const usage = getState().nearX402Usage(nearX402Config.config.network);
  json(res, 200, usage, { "Cache-Control": "public, max-age=30" });
}

async function respondPaymentAttempt(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  attemptId: string,
  port: number,
): Promise<void> {
  const attempt = nearPaymentAttempts.getByAttemptId(attemptId);
  if (!attempt) {
    json(res, 404, { error: "payment_attempt_not_found" }, { "Cache-Control": "no-store" });
    return;
  }
  const reconciled = attempt.status === "settled" ? await reconcileNearPayment(state, attempt.paymentProofHash) : attempt;
  const origin = nearX402Config.enabled
    ? nearX402Config.config.publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${port}`}`
    : `http://${req.headers.host ?? `localhost:${port}`}`;
  const receiptId = reconciled?.settlement?.externalReceiptId;
  json(res, 200, {
    schema_version: "cred402.near-payment-attempt.v1",
    attempt_id: reconciled?.attemptId,
    status: reconciled?.status,
    finality: reconciled?.finality
      ? {
          status: reconciled.finality.status,
          checked_at: reconciled.finality.checkedAt,
          confirmations: reconciled.finality.confirmations,
          minimum_finality_blocks: nearX402Config.enabled ? nearX402Config.config.minimumFinalityBlocks : undefined,
        }
      : null,
    transaction: reconciled?.settlement?.transaction ?? null,
    external_receipt_url: receiptId
      ? new URL(`/v1/x402/external-receipts/${encodeURIComponent(receiptId)}`, origin).href
      : null,
    guidance: reconciled?.status === "indeterminate"
      ? "Do not submit another payment. Reconciliation against the configured NEAR RPC is required."
      : undefined,
  }, { "Cache-Control": "private, no-store, max-age=0" });
}

async function respondCreditScore(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  url: URL,
  agentId: string,
  gateway: Gateway,
  port: number,
): Promise<void> {
  const { pathname } = url;
  const requestId = gateway.newRequestId();
  const routeLabel = "GET /v1/x402/near/credit-score/:agentId";
  const started = Date.now();
  const responsePolicy = nearX402PrivateResponseHeaders(requestId);
  const log = gateway.log.child({
    request_id: requestId,
    method: req.method,
    path: pathname,
    ip: (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, ""),
  });
  const respondJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    gateway.recordHttp(routeLabel, status);
    const fields = { status, ms: Date.now() - started };
    if (status >= 500) log.error("NEAR x402 request failed", fields);
    else if (status >= 400 && status !== 402) log.warn("NEAR x402 request rejected", fields);
    else log.info(status === 402 ? "NEAR x402 payment required" : "NEAR x402 request settled", fields);
    return json(res, status, body, { ...responsePolicy, ...headers });
  };
  const respondInstructions = (instructions: { status: number; headers: Record<string, string>; body?: unknown }) => {
    gateway.recordHttp(routeLabel, instructions.status);
    const fields = { status: instructions.status, ms: Date.now() - started };
    if (instructions.status >= 500) log.error("NEAR x402 request failed", fields);
    else if (instructions.status === 402) log.info("NEAR x402 payment required", fields);
    else log.warn("NEAR x402 payment rejected", fields);
    return sendInstructions(res, { ...instructions, headers: { ...instructions.headers, ...responsePolicy } });
  };

  const report = state.x402CreditScore(agentId);
  if ("error" in report) return respondJson(404, { error: "agent_not_found", message: report.error });
  if (!nearCreditScore || !nearX402Config.enabled) {
    return respondJson(503, {
      error: "near_x402_not_configured",
      message: nearX402Config.enabled ? "NEAR x402 is unavailable" : nearX402Config.reason,
    });
  }

  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : undefined;
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : undefined;
  const publicUrl = nearX402Config.config.publicBaseUrl
    ? `${nearX402Config.config.publicBaseUrl}${url.pathname}${url.search}`
    : `${forwardedProto ?? "http"}://${forwardedHost ?? req.headers.host ?? `localhost:${port}`}${url.pathname}${url.search}`;
  const context = createX402HttpContext({
    method: req.method ?? "GET",
    path: pathname,
    url: publicUrl,
    headers: req.headers,
    query: url.searchParams,
  });
  const paymentSignature = context.paymentHeader;
  const paymentProofHash = paymentSignature
    ? createHash("sha256").update(paymentSignature, "utf8").digest("hex")
    : undefined;
  const requestHash = hashObject({ method: req.method, url: publicUrl, agent_id: agentId }).slice(2);
  const paymentAttemptUrl = (attemptId: string) => new URL(`/v1/x402/near/payments/${attemptId}`, publicUrl).href;

  const replay = (proofHash: string): boolean => {
    const existing = nearPaymentAttempts.getByProofHash(proofHash);
    if (!existing) return false;
    if (existing.requestHash !== requestHash) {
      respondJson(409, {
        error: "x402_payment_replay_conflict",
        message: "This payment proof is already bound to a different resource request",
        payment_attempt_url: paymentAttemptUrl(existing.attemptId),
      });
      return true;
    }
    if (existing.status === "settled" && existing.settlement) {
      respondJson(200, existing.settlement.resourceResponse, existing.settlement.responseHeaders);
      return true;
    }
    if (existing.status === "failed") {
      respondJson(409, {
        error: existing.errorCode ?? "x402_settlement_failed",
        message: "This payment proof was already rejected and will not be retried",
        payment_attempt_url: paymentAttemptUrl(existing.attemptId),
      });
      return true;
    }
    respondJson(202, {
      error: existing.errorCode ?? "x402_settlement_in_progress",
      message: "Do not submit another payment while this attempt is being reconciled",
      attempt_id: existing.attemptId,
      payment_attempt_url: paymentAttemptUrl(existing.attemptId),
    }, { "Retry-After": "5" });
    return true;
  };
  if (paymentProofHash && replay(paymentProofHash)) return;

  const authorization = await nearCreditScore.authorize(context);
  if (authorization.type === "payment-error") return respondInstructions(authorization.response);
  if (!paymentProofHash) {
    return respondJson(400, { error: "x402_payment_signature_missing" });
  }
  const claim = nearPaymentAttempts.claim({ paymentProofHash, requestHash, requestId });
  if (!claim.created) {
    replay(paymentProofHash);
    return;
  }

  const settlement = await nearCreditScore.settle(authorization);
  if (!settlement.success) {
    if (settlement.indeterminate) {
      const attempt = nearPaymentAttempts.markIndeterminate(paymentProofHash);
      return respondJson(502, {
        error: "x402_settlement_indeterminate",
        message: "Settlement outcome is unknown. Do not pay again; use the attempt URL for reconciliation.",
        attempt_id: attempt.attemptId,
        payment_attempt_url: paymentAttemptUrl(attempt.attemptId),
      }, { "Retry-After": "5" });
    }
    nearPaymentAttempts.markFailed(paymentProofHash, "x402_settlement_rejected");
    return respondInstructions(settlement.response);
  }

  const amountYocto = settlement.amount;
  const basePayment = {
    protocol: "x402-v2",
    network: settlement.network,
    asset: "near-native",
    amount_yocto: amountYocto,
    payer: settlement.payer,
    transaction: settlement.transaction,
    external_receipt_id: null,
    external_receipt_url: null,
    payment_attempt_url: paymentAttemptUrl(claim.attempt.attemptId),
    near_finality: "pending",
    casper_anchor_status: "not_recorded",
  };
  nearPaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: "near-native",
    amountYocto,
    payer: settlement.payer,
    receiver: nearX402Config.config.payTo,
    transaction: settlement.transaction,
    responseHeaders: settlement.headers,
    resourceResponse: { ...report, payment: basePayment },
  });
  const anchoredReceipt = state.anchorNearCreditScoreSettlement({
    agentId,
    network: settlement.network,
    networkName: nearX402Config.config.networkName,
    amountYocto,
    payer: settlement.payer,
    receiver: nearX402Config.config.payTo,
    transaction: settlement.transaction,
    report,
  });
  const externalReceiptUrl = anchoredReceipt
    ? new URL(`/v1/x402/external-receipts/${encodeURIComponent(anchoredReceipt.receipt_id)}`, publicUrl).href
    : null;
  nearPaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: "near-native",
    amountYocto,
    payer: settlement.payer,
    receiver: nearX402Config.config.payTo,
    transaction: settlement.transaction,
    externalReceiptId: anchoredReceipt?.receipt_id,
    responseHeaders: settlement.headers,
    resourceResponse: { ...report, payment: basePayment },
  });
  const reconciled = await reconcileNearPayment(state, paymentProofHash);
  const receiptStatus = anchoredReceipt
    ? state.externalReceiptProof(anchoredReceipt.receipt_id)?.status ?? "anchored"
    : "not_recorded";
  const response = {
    ...report,
    payment: {
      ...basePayment,
      external_receipt_id: anchoredReceipt?.receipt_id ?? null,
      external_receipt_url: externalReceiptUrl,
      near_finality: reconciled?.finality?.status ?? "unavailable",
      confirmations: reconciled?.finality?.confirmations ?? null,
      casper_anchor_status: receiptStatus,
    },
  };
  nearPaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: "near-native",
    amountYocto,
    payer: settlement.payer,
    receiver: nearX402Config.config.payTo,
    transaction: settlement.transaction,
    externalReceiptId: anchoredReceipt?.receipt_id,
    responseHeaders: settlement.headers,
    resourceResponse: response,
  });
  respondJson(200, response, settlement.headers);
}

/**
 * Dispatch the NEAR x402 route family. Returns `true` when the request was
 * handled (response written), `false` to let the caller fall through to the
 * next matcher — mirroring `handleAlgorandX402` / `handleQieX402`'s ordering
 * contract.
 */
export async function handleNearX402(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  url: URL,
  deps: { gateway: Gateway; port: number },
): Promise<boolean> {
  const { gateway, port } = deps;
  const { pathname } = url;

  // Free, secret-free deployment probe. Never touches the NEAR RPC.
  if (pathname === NEAR_X402_STATUS_ROUTE && req.method === "GET") {
    json(res, 200, describeNearX402(nearX402Config), { "Cache-Control": "no-store" });
    return true;
  }

  if (pathname === "/v1/x402/near/usage" && req.method === "GET") {
    await respondUsage(res);
    return true;
  }

  const nearAttemptMatch = pathname.match(/^\/v1\/x402\/near\/payments\/(paynear_[0-9a-f]{32})$/);
  if (nearAttemptMatch && req.method === "GET") {
    await respondPaymentAttempt(req, res, state, nearAttemptMatch[1]!, port);
    return true;
  }

  // ---- NEAR x402 paid credit score (must run before the generic v1 router) ----
  const nearCreditMatch = pathname.match(/^\/v1\/x402\/near\/credit-score\/([^/]+)$/);
  if (nearCreditMatch && req.method === "GET") {
    await respondCreditScore(req, res, state, url, decodeURIComponent(nearCreditMatch[1]!), gateway, port);
    return true;
  }

  return false;
}
