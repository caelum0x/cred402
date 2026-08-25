import { type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { getState } from "./state.js";
import { json, sendInstructions } from "./http_utils.js";
import type { Gateway } from "../lib/gateway/index.js";
import { hashObject } from "../lib/core/hash.js";
import { verifyUniversalReceipt } from "../crosschain/standards/receipts.js";
import {
  AlgorandCreditScoreGateway,
  ALGORAND_X402_STATUS_ROUTE,
  algorandX402PrivateResponseHeaders,
  createX402HttpContext,
  describeAlgorandX402,
  loadAlgorandX402Config,
} from "../lib/x402/algorand_gateway.js";
import { verifyAlgorandAssetTransfer } from "../lib/x402/algorand_finality.js";

/**
 * Algorand x402 v2 paid credit-score domain.
 *
 * These are the cohesive request handlers extracted out of `server.ts` for the
 * Algorand x402 payment lifecycle: the status probe, per-attempt usage +
 * reconciliation, the public external-receipt proof, and the paid credit-score
 * settlement path. The reconciliation background loop lives here too, next to
 * the reconcile logic it drives. `server.ts` delegates to `handleAlgorandX402`
 * exactly like it already delegates to `handlePaidEvidence` / `v1.handle`.
 *
 * Behavior is unchanged from the inline version — only the code location moved.
 */

type State = ReturnType<typeof getState>;

const algorandX402Config = loadAlgorandX402Config();
const algorandCreditScore = algorandX402Config.enabled
  ? new AlgorandCreditScoreGateway(algorandX402Config.config)
  : undefined;

async function reconcileAlgorandPayment(
  state: State,
  paymentProofHash: string,
) {
  const attempt = state.algorandPaymentAttempts.getByProofHash(paymentProofHash);
  if (!attempt?.settlement || !algorandX402Config.enabled) return attempt;
  if (attempt.finality?.status === "confirmed" || attempt.finality?.status === "mismatch") return attempt;
  if (
    attempt.finality?.checkedAt &&
    Date.now() - Date.parse(attempt.finality.checkedAt) < algorandX402Config.config.reconciliationIntervalMs
  ) return attempt;

  const { settlement } = attempt;
  if (!settlement.transaction || !settlement.payer) {
    state.algorandPaymentAttempts.recordFinality(paymentProofHash, {
      status: "mismatch",
      reason: "facilitator settlement omitted transaction or payer",
    });
    if (settlement.externalReceiptId) {
      state.challengeAlgorandExternalReceipt(settlement.externalReceiptId);
    }
    return state.algorandPaymentAttempts.requireRefundReview(
      paymentProofHash,
      "Settlement cannot be independently verified because transaction identity is incomplete",
      settlement.transaction,
    );
  }

  const result = await verifyAlgorandAssetTransfer({
    indexerUrl: algorandX402Config.config.indexerUrl,
    indexerToken: algorandX402Config.config.indexerToken,
    timeoutMs: algorandX402Config.config.indexerTimeoutMs,
    minimumRounds: algorandX402Config.config.minimumFinalityRounds,
  }, {
    transaction: settlement.transaction,
    payer: settlement.payer,
    receiver: settlement.receiver,
    asset: settlement.asset,
    amountMicroUsdc: settlement.amountMicroUsdc,
  });
  let updated = state.algorandPaymentAttempts.recordFinality(paymentProofHash, {
    ...result,
  });

  if (result.status === "confirmed" && settlement.externalReceiptId) {
    state.finalizeAlgorandExternalReceipt(settlement.externalReceiptId);
  } else if (
    result.status === "mismatch" ||
    (result.status === "not_found" &&
      (updated.finality?.consecutiveMisses ?? 0) >= algorandX402Config.config.missingTransactionThreshold &&
      Date.now() - Date.parse(updated.createdAt) >= algorandX402Config.config.missingTransactionGraceMs)
  ) {
    if (settlement.externalReceiptId) {
      state.challengeAlgorandExternalReceipt(settlement.externalReceiptId);
    }
    updated = state.algorandPaymentAttempts.requireRefundReview(
      paymentProofHash,
      result.status === "mismatch"
        ? result.reason
        : "Transaction remained absent from the configured Indexer across reconciliation checks",
      settlement.transaction,
    );
  }
  return updated;
}

/**
 * Start the background reconciliation loop that reconfirms settled Algorand
 * payments against the Indexer. No-op when the Algorand x402 path is disabled.
 */
export function startAlgorandReconciliation(gateway: Gateway): void {
  if (!algorandX402Config.enabled) return;
  let reconciliationRunning = false;
  const timer = setInterval(async () => {
    if (reconciliationRunning) return;
    reconciliationRunning = true;
    try {
      const pending = getState().algorandPaymentAttempts.list()
        .filter((attempt) =>
          attempt.status === "settled" &&
          attempt.finality?.status !== "confirmed" &&
          attempt.finality?.status !== "mismatch",
        )
        .slice(0, 100);
      for (const attempt of pending) {
        try {
          await reconcileAlgorandPayment(getState(), attempt.paymentProofHash);
        } catch (error) {
          gateway.log.warn("Algorand payment reconciliation failed", {
            attempt_id: attempt.attemptId,
            error: error instanceof Error ? error.message : "unknown reconciliation error",
          });
        }
      }
    } finally {
      reconciliationRunning = false;
    }
  }, algorandX402Config.config.reconciliationIntervalMs);
  timer.unref();
}

async function respondUsage(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  port: number,
): Promise<void> {
  if (!algorandX402Config.enabled) {
    json(res, 503, {
      error: "algorand_x402_not_configured",
      message: algorandX402Config.reason,
    }, { "Cache-Control": "no-store" });
    return;
  }
  const usage = state.algorandX402Usage(
    algorandX402Config.config.network,
    algorandX402Config.config.usdcAsset,
  );
  const origin = algorandX402Config.config.publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${port}`}`;
  json(res, 200, {
    ...usage,
    latest_receipts: usage.latest_receipts.map((receipt) => ({
      ...receipt,
      proof_url: new URL(
        `/v1/x402/external-receipts/${encodeURIComponent(receipt.receipt_id)}`,
        origin,
      ).href,
    })),
  }, { "Cache-Control": "public, max-age=30" });
}

async function respondPaymentAttempt(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  attemptId: string,
  port: number,
): Promise<void> {
  const attempt = state.algorandPaymentAttempts.getByAttemptId(attemptId);
  if (!attempt) {
    json(res, 404, { error: "payment_attempt_not_found" }, { "Cache-Control": "no-store" });
    return;
  }
  const reconciled = attempt.status === "settled"
    ? await reconcileAlgorandPayment(state, attempt.paymentProofHash)
    : attempt;
  const origin = algorandX402Config.enabled
    ? algorandX402Config.config.publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${port}`}`
    : `http://${req.headers.host ?? `localhost:${port}`}`;
  const receiptId = reconciled?.settlement?.externalReceiptId;
  json(res, 200, {
    schema_version: "cred402.algorand-payment-attempt.v1",
    attempt_id: reconciled?.attemptId,
    status: reconciled?.status,
    finality: reconciled?.finality
      ? {
          status: reconciled.finality.status,
          checked_at: reconciled.finality.checkedAt,
          confirmations: reconciled.finality.confirmations,
          minimum_rounds: algorandX402Config.enabled
            ? algorandX402Config.config.minimumFinalityRounds
            : undefined,
        }
      : null,
    refund: {
      status: reconciled?.refund.status,
      updated_at: reconciled?.refund.updatedAt,
    },
    transaction: reconciled?.settlement?.transaction ?? null,
    external_receipt_url: receiptId
      ? new URL(`/v1/x402/external-receipts/${encodeURIComponent(receiptId)}`, origin).href
      : null,
    guidance: reconciled?.status === "indeterminate"
      ? "Do not submit another payment. Reconciliation is required."
      : undefined,
  }, { "Cache-Control": "private, no-store, max-age=0" });
}

// Public proof for a settled cross-chain x402 receipt. Receipt ids are
// content hashes of the canonical envelope, so callers can independently
// verify integrity without an API key or access to the paid report itself.
function respondExternalReceipt(res: ServerResponse, state: State, receiptId: string): void {
  const receipt = state.externalReceiptProof(receiptId);
  if (!receipt) {
    json(res, 404, {
      error: "receipt_not_found",
      message: "External x402 receipt not found",
    }, { "Cache-Control": "no-store" });
    return;
  }
  const integrity = verifyUniversalReceipt(receipt.envelope, receipt.receipt_id);
  json(res, 200, {
    schema_version: "cred402.external-receipt-proof.v1",
    receipt_id: receipt.receipt_id,
    integrity,
    anchor: {
      ledger: "casper",
      status: receipt.status,
      anchored_at: receipt.anchored_at,
    },
    settlement: {
      origin_chain: receipt.origin_chain,
      network: receipt.settlement_network,
      transaction: receipt.settlement_tx_hash,
      asset: receipt.asset,
      amount: receipt.amount,
    },
    parties: {
      payer_agent_id: receipt.payer_agent_id,
      seller_agent_id: receipt.seller_agent_id,
    },
    envelope: receipt.envelope,
  }, { "Cache-Control": "public, max-age=60" });
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
  const routeLabel = "GET /v1/x402/credit-score/:agentId";
  const started = Date.now();
  const responsePolicy = algorandX402PrivateResponseHeaders(requestId);
  const log = gateway.log.child({
    request_id: requestId,
    method: req.method,
    path: pathname,
    ip: (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, ""),
  });
  const respondJson = (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    gateway.recordHttp(routeLabel, status);
    const fields = { status, ms: Date.now() - started };
    if (status >= 500) log.error("Algorand x402 request failed", fields);
    else if (status >= 400 && status !== 402) log.warn("Algorand x402 request rejected", fields);
    else log.info(status === 402 ? "Algorand x402 payment required" : "Algorand x402 request settled", fields);
    return json(res, status, body, { ...responsePolicy, ...headers });
  };
  const respondInstructions = (instructions: {
    status: number;
    headers: Record<string, string>;
    body?: unknown;
  }) => {
    gateway.recordHttp(routeLabel, instructions.status);
    const fields = { status: instructions.status, ms: Date.now() - started };
    if (instructions.status >= 500) log.error("Algorand x402 request failed", fields);
    else if (instructions.status === 402) log.info("Algorand x402 payment required", fields);
    else log.warn("Algorand x402 payment rejected", fields);
    return sendInstructions(res, {
      ...instructions,
      headers: { ...instructions.headers, ...responsePolicy },
    });
  };

  const report = state.x402CreditScore(agentId);
  if ("error" in report) return respondJson(404, { error: "agent_not_found", message: report.error });
  if (!algorandCreditScore || !algorandX402Config.enabled) {
    return respondJson(503, {
      error: "algorand_x402_not_configured",
      message: algorandX402Config.enabled ? "Algorand x402 is unavailable" : algorandX402Config.reason,
    });
  }

  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : undefined;
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : undefined;
  const publicUrl = algorandX402Config.config.publicBaseUrl
    ? `${algorandX402Config.config.publicBaseUrl}${url.pathname}${url.search}`
    : `${forwardedProto ?? "http"}://${forwardedHost ?? req.headers.host ?? `localhost:${port}`}${url.pathname}${url.search}`;
  const context = createX402HttpContext({
    // Only reached on the GET path (see handleAlgorandX402); the `?? "GET"`
    // restores the method narrowing the enclosing route guard provided inline.
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
  const paymentAttemptUrl = (attemptId: string) => new URL(
    `/v1/x402/algorand/payments/${attemptId}`,
    publicUrl,
  ).href;
  const replay = (proofHash: string) => {
    const existing = state.algorandPaymentAttempts.getByProofHash(proofHash);
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
    authorization = await algorandCreditScore.authorize(context);
  } catch (error) {
    return respondJson(502, {
      error: "x402_facilitator_unavailable",
      message: error instanceof Error ? error.message : "Unable to initialize the Algorand facilitator",
    });
  }
  if (authorization.type === "payment-error") return respondInstructions(authorization.response);
  if (authorization.type !== "payment-verified") {
    return respondJson(500, { error: "x402_route_misconfigured" });
  }
  if (!paymentProofHash) {
    return respondJson(400, { error: "x402_payment_signature_missing" });
  }
  const claim = state.algorandPaymentAttempts.claim({
    paymentProofHash,
    requestHash,
    requestId,
  });
  if (!claim.created) {
    replay(paymentProofHash);
    return;
  }

  const responseBody = Buffer.from(JSON.stringify(report));
  let settlement;
  try {
    settlement = await algorandCreditScore.settle(authorization, context, responseBody);
  } catch (error) {
    // A facilitator timeout is an indeterminate settlement outcome: the
    // on-chain transfer may already have completed. Do not attempt a second
    // settlement or cancellation here; surface the uncertainty to the caller.
    const attempt = state.algorandPaymentAttempts.markIndeterminate(paymentProofHash);
    return respondJson(502, {
      error: "x402_settlement_indeterminate",
      message: "Settlement outcome is unknown. Do not pay again; use the attempt URL for reconciliation.",
      attempt_id: attempt.attemptId,
      payment_attempt_url: paymentAttemptUrl(attempt.attemptId),
    }, { "Retry-After": "5" });
  }
  if (!settlement.success) {
    state.algorandPaymentAttempts.markFailed(paymentProofHash, "x402_settlement_rejected");
    return respondInstructions(settlement.response);
  }

  const amountMicroUsdc = settlement.amount ?? algorandX402Config.config.priceMicroUsdc;
  const basePayment = {
    protocol: "x402-v2",
    network: settlement.network,
    asset: algorandX402Config.config.usdcAsset,
    amount_micro_usdc: amountMicroUsdc,
    payer: settlement.payer,
    transaction: settlement.transaction,
    external_receipt_id: null,
    external_receipt_url: null,
    payment_attempt_url: paymentAttemptUrl(claim.attempt.attemptId),
    algorand_finality: "pending",
    casper_anchor_status: "not_recorded",
  };
  state.algorandPaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: algorandX402Config.config.usdcAsset,
    amountMicroUsdc,
    payer: settlement.payer,
    receiver: algorandX402Config.config.payTo,
    transaction: settlement.transaction,
    responseHeaders: settlement.headers,
    resourceResponse: { ...report, payment: basePayment },
  });
  const anchoredReceipt = state.anchorAlgorandCreditScoreSettlement({
    agentId,
    network: settlement.network,
    networkName: algorandX402Config.config.networkName,
    usdcAsset: algorandX402Config.config.usdcAsset,
    amountMicroUsdc,
    payer: settlement.payer,
    receiver: algorandX402Config.config.payTo,
    transaction: settlement.transaction,
    report,
  });
  const externalReceiptUrl = anchoredReceipt
    ? new URL(
        `/v1/x402/external-receipts/${encodeURIComponent(anchoredReceipt.receipt_id)}`,
        publicUrl,
      ).href
    : null;
  state.algorandPaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: algorandX402Config.config.usdcAsset,
    amountMicroUsdc,
    payer: settlement.payer,
    receiver: algorandX402Config.config.payTo,
    transaction: settlement.transaction,
    externalReceiptId: anchoredReceipt?.receipt_id,
    responseHeaders: settlement.headers,
    resourceResponse: { ...report, payment: basePayment },
  });
  const reconciled = await reconcileAlgorandPayment(state, paymentProofHash);
  const receiptStatus = anchoredReceipt
    ? state.externalReceiptProof(anchoredReceipt.receipt_id)?.status ?? "anchored"
    : "not_recorded";
  const response = {
    ...report,
    payment: {
      ...basePayment,
      external_receipt_id: anchoredReceipt?.receipt_id ?? null,
      external_receipt_url: externalReceiptUrl,
      algorand_finality: reconciled?.finality?.status ?? "unavailable",
      confirmations: reconciled?.finality?.confirmations ?? null,
      casper_anchor_status: receiptStatus,
    },
  };
  state.algorandPaymentAttempts.settle(paymentProofHash, {
    network: settlement.network,
    asset: algorandX402Config.config.usdcAsset,
    amountMicroUsdc,
    payer: settlement.payer,
    receiver: algorandX402Config.config.payTo,
    transaction: settlement.transaction,
    externalReceiptId: anchoredReceipt?.receipt_id,
    responseHeaders: settlement.headers,
    resourceResponse: response,
  });
  respondJson(200, response, settlement.headers);
}

/**
 * Dispatch the Algorand x402 route family. Returns `true` when the request was
 * handled (response written), `false` to let the caller fall through to the
 * next matcher — mirroring the pre-extraction inline ordering exactly.
 */
export async function handleAlgorandX402(
  req: IncomingMessage,
  res: ServerResponse,
  state: State,
  url: URL,
  deps: { gateway: Gateway; port: number },
): Promise<boolean> {
  const { gateway, port } = deps;
  const { pathname } = url;

  // Free, secret-free deployment probe. It never initializes the facilitator.
  if (pathname === ALGORAND_X402_STATUS_ROUTE && req.method === "GET") {
    json(res, 200, describeAlgorandX402(algorandX402Config), { "Cache-Control": "no-store" });
    return true;
  }

  if (pathname === "/v1/x402/algorand/usage" && req.method === "GET") {
    await respondUsage(req, res, state, port);
    return true;
  }

  const algorandAttemptMatch = pathname.match(/^\/v1\/x402\/algorand\/payments\/(pay_[0-9a-f]{32})$/);
  if (algorandAttemptMatch && req.method === "GET") {
    await respondPaymentAttempt(req, res, state, algorandAttemptMatch[1]!, port);
    return true;
  }

  const externalReceiptMatch = pathname.match(/^\/v1\/x402\/external-receipts\/([^/]+)$/);
  if (externalReceiptMatch && req.method === "GET") {
    respondExternalReceipt(res, state, decodeURIComponent(externalReceiptMatch[1]!));
    return true;
  }

  // ---- Algorand x402 v2 paid credit score (must run before the generic v1 router) ----
  const algorandCreditMatch = pathname.match(/^\/v1\/x402\/credit-score\/([^/]+)$/);
  if (algorandCreditMatch && req.method === "GET") {
    await respondCreditScore(req, res, state, url, decodeURIComponent(algorandCreditMatch[1]!), gateway, port);
    return true;
  }

  return false;
}
