import { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { getState } from "./state.js";
import { json, sendInstructions } from "./http_utils.js";
import type { Gateway } from "../lib/gateway/index.js";
import { hashObject } from "../lib/core/hash.js";
import {
  QieCreditScoreGateway,
  QIE_X402_STATUS_ROUTE,
  createX402HttpContext,
  describeQieX402,
  loadQieX402Config,
  qieX402PrivateResponseHeaders,
} from "../lib/x402/qie_gateway.js";
import { QiePaymentAttemptStore } from "../lib/x402/qie_payment_attempt_store.js";
import { verifyQieAssetTransfer } from "../lib/x402/qie_finality.js";

/**
 * QIE Blockchain Hackathon 3.0 x402 paid credit-score domain.
 *
 * Structurally mirrors `algorand_x402_routes.ts` (status probe, per-attempt
 * reconciliation, paid credit-score settlement) with the chain-specific
 * pieces swapped for EVM: `QieCreditScoreGateway` (EVM "exact" scheme over
 * `@x402/core`) instead of `AlgorandCreditScoreGateway`, and a direct RPC
 * finality check (`verifyQieAssetTransfer`) instead of an Algorand Indexer
 * read, since no Indexer-equivalent REST API for QIE is confirmed by
 * research. `server.ts` delegates to `handleQieX402` exactly like it already
 * delegates to `handleAlgorandX402`.
 */

type State = ReturnType<typeof getState>;

const qieX402Config = loadQieX402Config();
const qieCreditScore = qieX402Config.enabled ? new QieCreditScoreGateway(qieX402Config.config) : undefined;
const qiePaymentAttempts = new QiePaymentAttemptStore(
  qieX402Config.enabled ? process.env.CRED402_DATA_DIR?.trim() : undefined,
);

async function reconcileQiePayment(state: State, paymentProofHash: string) {
  const attempt = qiePaymentAttempts.getByProofHash(paymentProofHash);
  if (!attempt?.settlement || !qieX402Config.enabled) return attempt;
  if (attempt.finality?.status === "confirmed" || attempt.finality?.status === "mismatch") return attempt;

  const { settlement } = attempt;
  if (!settlement.transaction) {
    if (settlement.externalReceiptId) {
      state.challengeQieExternalReceipt(settlement.externalReceiptId);
    }
    return qiePaymentAttempts.recordFinality(paymentProofHash, {
      status: "mismatch",
      checkedAt: new Date().toISOString(),
      reason: "Facilitator settlement omitted a transaction hash",
    });
  }

  const result = await verifyQieAssetTransfer(
    {
      rpcUrl: qieX402Config.config.rpcUrl,
      timeoutMs: qieX402Config.config.rpcTimeoutMs,
      minimumConfirmations: qieX402Config.config.minimumConfirmations,
    },
    {
      transaction: settlement.transaction,
      asset: settlement.asset,
      receiver: qieX402Config.config.payTo,
      amountBaseUnits: settlement.amountBaseUnits,
    },
  );
  const updated = qiePaymentAttempts.recordFinality(paymentProofHash, result);
  if (result.status === "confirmed" && settlement.externalReceiptId) {
    state.finalizeQieExternalReceipt(settlement.externalReceiptId);
  } else if (result.status === "mismatch" && settlement.externalReceiptId) {
    state.challengeQieExternalReceipt(settlement.externalReceiptId);
  }
  return updated;
}

async function respondPaymentAttempt(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  attemptId: string,
  port: number,
): Promise<void> {
  const attempt = qiePaymentAttempts.getByAttemptId(attemptId);
  if (!attempt) {
    json(res, 404, { error: "payment_attempt_not_found" }, { "Cache-Control": "no-store" });
    return;
  }
  const reconciled = attempt.status === "settled" ? await reconcileQiePayment(state, attempt.paymentProofHash) : attempt;
  const origin = qieX402Config.enabled
    ? qieX402Config.config.publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${port}`}`
    : `http://${req.headers.host ?? `localhost:${port}`}`;
  const receiptId = reconciled?.settlement?.externalReceiptId;
  json(res, 200, {
    schema_version: "cred402.qie-payment-attempt.v1",
    attempt_id: reconciled?.attemptId,
    status: reconciled?.status,
    finality: reconciled?.finality
      ? {
          status: reconciled.finality.status,
          checked_at: reconciled.finality.checkedAt,
          confirmations: reconciled.finality.confirmations,
          minimum_confirmations: qieX402Config.enabled ? qieX402Config.config.minimumConfirmations : undefined,
        }
      : null,
    transaction: reconciled?.settlement?.transaction ?? null,
    external_receipt_url: receiptId
      ? new URL(`/v1/x402/external-receipts/${encodeURIComponent(receiptId)}`, origin).href
      : null,
    guidance: reconciled?.status === "indeterminate"
      ? "Do not submit another payment. Reconciliation against the configured QIE RPC is required."
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
  const routeLabel = "GET /v1/x402/qie/credit-score/:agentId";
  const started = Date.now();
  const responsePolicy = qieX402PrivateResponseHeaders(requestId);
  const log = gateway.log.child({
    request_id: requestId,
    method: req.method,
    path: pathname,
    ip: (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, ""),
  });
  const respondJson = (status: number, body: unknown, headers: Record<string, string> = {}) => {
    gateway.recordHttp(routeLabel, status);
    const fields = { status, ms: Date.now() - started };
    if (status >= 500) log.error("QIE x402 request failed", fields);
    else if (status >= 400 && status !== 402) log.warn("QIE x402 request rejected", fields);
    else log.info(status === 402 ? "QIE x402 payment required" : "QIE x402 request settled", fields);
    return json(res, status, body, { ...responsePolicy, ...headers });
  };
  const respondInstructions = (instructions: { status: number; headers: Record<string, string>; body?: unknown }) => {
    gateway.recordHttp(routeLabel, instructions.status);
    const fields = { status: instructions.status, ms: Date.now() - started };
    if (instructions.status >= 500) log.error("QIE x402 request failed", fields);
    else if (instructions.status === 402) log.info("QIE x402 payment required", fields);
    else log.warn("QIE x402 payment rejected", fields);
    return sendInstructions(res, { ...instructions, headers: { ...instructions.headers, ...responsePolicy } });
  };

  const report = state.x402CreditScore(agentId);
  if ("error" in report) return respondJson(404, { error: "agent_not_found", message: report.error });
  if (!qieCreditScore || !qieX402Config.enabled) {
    return respondJson(503, {
      error: "qie_x402_not_configured",
      message: qieX402Config.enabled ? "QIE x402 is unavailable" : qieX402Config.reason,
    });
  }

  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : undefined;
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : undefined;
  const publicUrl = qieX402Config.config.publicBaseUrl
    ? `${qieX402Config.config.publicBaseUrl}${url.pathname}${url.search}`
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
  const paymentAttemptUrl = (attemptId: string) => new URL(`/v1/x402/qie/payments/${attemptId}`, publicUrl).href;

  const replay = (proofHash: string): boolean => {
    const existing = qiePaymentAttempts.getByProofHash(proofHash);
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

  let authorization;
  try {
    authorization = await qieCreditScore.authorize(context);
  } catch (error) {
    return respondJson(502, {
      error: "x402_facilitator_unavailable",
      message: error instanceof Error ? error.message : "Unable to initialize the QIE facilitator",
    });
  }
  if (authorization.type === "payment-error") return respondInstructions(authorization.response);
  if (authorization.type !== "payment-verified") {
    return respondJson(500, { error: "x402_route_misconfigured" });
  }
  if (!paymentProofHash) {
    return respondJson(400, { error: "x402_payment_signature_missing" });
  }
  const claim = qiePaymentAttempts.claim({ paymentProofHash, requestHash, requestId });
  if (!claim.created) {
    replay(paymentProofHash);
    return;
  }

  const responseBody = Buffer.from(JSON.stringify(report));
  let settlement;
  try {
    settlement = await qieCreditScore.settle(authorization, context, responseBody);
  } catch (error) {
    const attempt = qiePaymentAttempts.markIndeterminate(paymentProofHash);
    return respondJson(502, {
      error: "x402_settlement_indeterminate",
      message: "Settlement outcome is unknown. Do not pay again; use the attempt URL for reconciliation.",
      attempt_id: attempt.attemptId,
      payment_attempt_url: paymentAttemptUrl(attempt.attemptId),
    }, { "Retry-After": "5" });
  }
  if (!settlement.success) {
    qiePaymentAttempts.markFailed(paymentProofHash, "x402_settlement_rejected");
    return respondInstructions(settlement.response);
  }

  const amountBaseUnits = settlement.amount ?? qieX402Config.config.priceBaseUnits;
  const basePayment = {
    protocol: "x402-v2",
    network: settlement.network,
    asset: qieX402Config.config.assetAddress,
    amount_base_units: amountBaseUnits,
    payer: settlement.payer,
    transaction: settlement.transaction,
    external_receipt_id: null,
    external_receipt_url: null,
    payment_attempt_url: paymentAttemptUrl(claim.attempt.attemptId),
    qie_finality: "pending",
    casper_anchor_status: "not_recorded",
  };
  qiePaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: qieX402Config.config.assetAddress,
    amountBaseUnits,
    payer: settlement.payer,
    receiver: qieX402Config.config.payTo,
    transaction: settlement.transaction,
    responseHeaders: settlement.headers,
    resourceResponse: { ...report, payment: basePayment },
  });
  const anchoredReceipt = state.anchorQieCreditScoreSettlement({
    agentId,
    network: settlement.network,
    networkName: qieX402Config.config.networkName,
    assetAddress: qieX402Config.config.assetAddress,
    amountBaseUnits,
    payer: settlement.payer,
    receiver: qieX402Config.config.payTo,
    transaction: settlement.transaction,
    report,
  });
  const externalReceiptUrl = anchoredReceipt
    ? new URL(
        `/v1/x402/external-receipts/${encodeURIComponent(anchoredReceipt.receipt_id)}`,
        publicUrl,
      ).href
    : null;
  qiePaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: qieX402Config.config.assetAddress,
    amountBaseUnits,
    payer: settlement.payer,
    receiver: qieX402Config.config.payTo,
    transaction: settlement.transaction,
    externalReceiptId: anchoredReceipt?.receipt_id,
    responseHeaders: settlement.headers,
    resourceResponse: { ...report, payment: basePayment },
  });
  const reconciled = settlement.transaction ? await reconcileQiePayment(state, paymentProofHash) : undefined;
  const receiptStatus = anchoredReceipt
    ? state.externalReceiptProof(anchoredReceipt.receipt_id)?.status ?? "anchored"
    : "not_recorded";
  const response = {
    ...report,
    payment: {
      ...basePayment,
      external_receipt_id: anchoredReceipt?.receipt_id ?? null,
      external_receipt_url: externalReceiptUrl,
      qie_finality: reconciled?.finality?.status ?? "unavailable",
      confirmations: reconciled?.finality?.confirmations ?? null,
      casper_anchor_status: receiptStatus,
    },
  };
  qiePaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: qieX402Config.config.assetAddress,
    amountBaseUnits,
    payer: settlement.payer,
    receiver: qieX402Config.config.payTo,
    transaction: settlement.transaction,
    externalReceiptId: anchoredReceipt?.receipt_id,
    responseHeaders: settlement.headers,
    resourceResponse: response,
  });
  respondJson(200, response, settlement.headers);
}

/**
 * Dispatch the QIE x402 route family. Returns `true` when the request was
 * handled (response written), `false` to let the caller fall through to the
 * next matcher — mirroring `handleAlgorandX402`'s ordering contract.
 */
export async function handleQieX402(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  url: URL,
  deps: { gateway: Gateway; port: number },
): Promise<boolean> {
  const { gateway, port } = deps;
  const { pathname } = url;

  // Free, secret-free deployment probe. It never initializes the facilitator.
  if (pathname === QIE_X402_STATUS_ROUTE && req.method === "GET") {
    json(res, 200, describeQieX402(qieX402Config), { "Cache-Control": "no-store" });
    return true;
  }

  const qieAttemptMatch = pathname.match(/^\/v1\/x402\/qie\/payments\/(payqie_[0-9a-f]{32})$/);
  if (qieAttemptMatch && req.method === "GET") {
    await respondPaymentAttempt(req, res, state, qieAttemptMatch[1]!, port);
    return true;
  }

  // ---- QIE x402 v2 paid credit score (must run before the generic v1 router) ----
  const qieCreditMatch = pathname.match(/^\/v1\/x402\/qie\/credit-score\/([^/]+)$/);
  if (qieCreditMatch && req.method === "GET") {
    await respondCreditScore(req, res, state, url, decodeURIComponent(qieCreditMatch[1]!), gateway, port);
    return true;
  }

  return false;
}
