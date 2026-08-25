import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { getState } from "./state.js";
import { json, sendInstructions, readBody, readRawBody, serveStatic } from "./http_utils.js";
import { handlePaidEvidence } from "./paid_evidence_server/index.js";
import { Gateway, loadConfig, toApiError } from "../lib/gateway/index.js";
import { V1Router } from "./v1/router.js";
import { executeGraphQL, introspectionQuery } from "../lib/graphql/index.js";
import { GRAPHIQL_HTML } from "../lib/graphql/explorer_html.js";
import { renderMetrics } from "../lib/gateway/metrics.js";
import { toCsv } from "../lib/services/csv.js";
import { loadChainManifest } from "../lib/services/chain_manifest.js";
import { renderCreditReportHtml } from "../lib/services/report_html.js";
import type { CreditReport } from "../lib/services/credit_report.js";
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
 * Cred402 API server — zero external dependencies (node:http only).
 *
 *   REST:   /api/state /api/agents /api/receipts /api/evidence /api/jobs /api/pool
 *   Events: /api/events?since=N   and SSE at /api/events/stream
 *   Demo:   POST /api/demo/run  /api/demo/dispute  /api/demo/reset
 *   Policy: POST /api/policy/upgrade   { "version": "v2" }
 *   x402:   GET /verify/:evidence_type?rwa_id=SOLAR-A17
 *   Static: serves frontend/dist when built
 */
// Honor the platform-provided PORT (Render/Heroku/etc.), then CRED402_PORT, then default.
const PORT = Number(process.env.PORT ?? process.env.CRED402_PORT ?? 4021);

/** Flatten a read model into CSV-ready rows for the export endpoints. */
function csvRows(state: ReturnType<typeof getState>, resource: string): Array<Record<string, unknown>> | null {
  switch (resource) {
    case "agents":
      return state.ledger.agents.list().map((a) => ({
        agent_id: a.agent_id, service_type: a.service_type, reputation: a.reputation_score,
        credit_score: a.credit_score, dispute_rate: a.dispute_rate, stake_motes: a.stake.toString(),
        jobs: a.total_jobs_completed, active: a.active,
      }));
    case "receipts":
      return state.ledger.receipts.list().map((r) => ({
        receipt_id: r.receipt_id, payer: r.payer_agent, seller: r.seller_agent,
        service_type: r.service_type, amount_motes: r.amount.toString(), status: r.status, timestamp: r.timestamp,
      }));
    case "events":
      // Full on-chain event log for audit/observability — every contract call.
      return state.ledger.bus.all().map((e) => ({
        seq: e.seq, event: e.name, contract: e.contract, deploy_hash: e.deploy_hash,
        timestamp: e.timestamp, data: JSON.stringify(e.data),
      }));
    case "leaderboard":
      return state.analytics().leaderboard.map((r) => ({ ...r }));
    case "credit-lines":
      return state.ledger.pool.list().map((l) => ({
        agent_id: l.agent_id, max_credit_motes: l.max_credit.toString(), drawn_motes: l.drawn.toString(),
        interest_rate_bps: l.interest_rate_bps, status: l.status,
      }));
    case "bureau": {
      // Analyst roster: discovery ranking joined with per-agent credit readiness.
      const discovery = state.discover({ limit: 200 }) as unknown as { results: Array<Record<string, unknown>> };
      return discovery.results.map((r) => {
        const readiness = state.onboardingScorecard(String(r.agent_id));
        const ready = readiness && !("error" in readiness) ? readiness.ready : false;
        const readinessPct = readiness && !("error" in readiness) ? readiness.readiness_pct : 0;
        return {
          rank: r.rank, agent_id: r.agent_id, service_type: r.service_type, discovery_score: r.score,
          tier: r.tier, reputation: r.reputation, credit_score: r.credit_score, trust_score: r.trust_score,
          fraud_score: r.fraud_score, revenue_motes: r.revenue_motes, recommended: r.recommended,
          credit_ready: ready, readiness_pct: readinessPct,
        };
      });
    }
    default:
      return null;
  }
}

const gateway = new Gateway(loadConfig());
const v1 = new V1Router(gateway, getState());
const algorandX402Config = loadAlgorandX402Config();
const algorandCreditScore = algorandX402Config.enabled
  ? new AlgorandCreditScoreGateway(algorandX402Config.config)
  : undefined;

async function reconcileAlgorandPayment(
  state: ReturnType<typeof getState>,
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

if (algorandX402Config.enabled) {
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

// Fan protocol events out to registered webhook subscribers (HMAC-signed, retried).
getState().ledger.bus.subscribe((e) => {
  void gateway.webhooks.dispatch(e.name, { seq: e.seq, contract: e.contract, deploy_hash: e.deploy_hash, ...e.data });
});

const server = createServer(async (req, res) => {
  const state = getState();
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    json(res, 204, {});
    return;
  }

  try {
    if (pathname.startsWith("/api/demo/") && loadConfig().env !== "development") {
      return json(res, 404, { error: "not_found" }, { "Cache-Control": "no-store" });
    }

    // Free, secret-free deployment probe. It never initializes the facilitator.
    if (pathname === ALGORAND_X402_STATUS_ROUTE && req.method === "GET") {
      return json(res, 200, describeAlgorandX402(algorandX402Config), {
        "Cache-Control": "no-store",
      });
    }

    if (pathname === "/v1/x402/algorand/usage" && req.method === "GET") {
      if (!algorandX402Config.enabled) {
        return json(res, 503, {
          error: "algorand_x402_not_configured",
          message: algorandX402Config.reason,
        }, { "Cache-Control": "no-store" });
      }
      const usage = state.algorandX402Usage(
        algorandX402Config.config.network,
        algorandX402Config.config.usdcAsset,
      );
      const origin = algorandX402Config.config.publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${PORT}`}`;
      return json(res, 200, {
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

    const algorandAttemptMatch = pathname.match(/^\/v1\/x402\/algorand\/payments\/(pay_[0-9a-f]{32})$/);
    if (algorandAttemptMatch && req.method === "GET") {
      const attempt = state.algorandPaymentAttempts.getByAttemptId(algorandAttemptMatch[1]!);
      if (!attempt) {
        return json(res, 404, { error: "payment_attempt_not_found" }, { "Cache-Control": "no-store" });
      }
      const reconciled = attempt.status === "settled"
        ? await reconcileAlgorandPayment(state, attempt.paymentProofHash)
        : attempt;
      const origin = algorandX402Config.enabled
        ? algorandX402Config.config.publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${PORT}`}`
        : `http://${req.headers.host ?? `localhost:${PORT}`}`;
      const receiptId = reconciled?.settlement?.externalReceiptId;
      return json(res, 200, {
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
    const externalReceiptMatch = pathname.match(/^\/v1\/x402\/external-receipts\/([^/]+)$/);
    if (externalReceiptMatch && req.method === "GET") {
      const receiptId = decodeURIComponent(externalReceiptMatch[1]!);
      const receipt = state.externalReceiptProof(receiptId);
      if (!receipt) {
        return json(res, 404, {
          error: "receipt_not_found",
          message: "External x402 receipt not found",
        }, { "Cache-Control": "no-store" });
      }
      const integrity = verifyUniversalReceipt(receipt.envelope, receipt.receipt_id);
      return json(res, 200, {
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

    // ---- Algorand x402 v2 paid credit score (must run before the generic v1 router) ----
    const algorandCreditMatch = pathname.match(/^\/v1\/x402\/credit-score\/([^/]+)$/);
    if (algorandCreditMatch && req.method === "GET") {
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

      const agentId = decodeURIComponent(algorandCreditMatch[1]!);
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
        : `${forwardedProto ?? "http"}://${forwardedHost ?? req.headers.host ?? `localhost:${PORT}`}${url.pathname}${url.search}`;
      const context = createX402HttpContext({
        method: req.method,
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
      return respondJson(200, response, settlement.headers);
    }

    // ---- production versioned API (auth + rate limit + validation + envelope) ----
    if (pathname === "/v1" || pathname.startsWith("/v1/")) {
      if (await v1.handle(req, res, url)) return;
    }

    // ---- live analytics stream (SSE) ----
    if (pathname === "/api/analytics/stream" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      const sendAnalytics = () => {
        const payload = JSON.stringify(state.analytics(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        res.write(`event: analytics\ndata: ${payload}\n\n`);
      };
      sendAnalytics();
      // Push a fresh snapshot at most once per second when events fire.
      let pending: NodeJS.Timeout | null = null;
      const unsub = state.ledger.bus.subscribe(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          sendAnalytics();
        }, 1000);
      });
      const keepAlive = setInterval(() => res.write(`: ka\n\n`), 15000);
      req.on("close", () => {
        if (pending) clearTimeout(pending);
        clearInterval(keepAlive);
        unsub();
      });
      return;
    }

    // ---- public shareable credit report (HTML) ----
    if (pathname.startsWith("/report/") && req.method === "GET") {
      const agentId = decodeURIComponent(pathname.replace("/report/", ""));
      const report = state.creditReport(agentId) as CreditReport | { error: string };
      if ("error" in report) {
        res.writeHead(404, { "Content-Type": "text/html" }).end(`<h1>404</h1><p>${report.error}</p>`);
        return;
      }
      const trend = state.scoreTrend(agentId);
      const benchmark = state.peerBenchmark(agentId);
      const readiness = state.onboardingScorecard(agentId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(
        renderCreditReportHtml(report, {
          trend: "error" in trend ? undefined : trend,
          benchmark: "error" in benchmark ? undefined : benchmark,
          readiness: "error" in readiness ? undefined : readiness,
        }),
      );
      return;
    }

    // ---- CSV export ----
    if (pathname.startsWith("/api/export/") && req.method === "GET") {
      const resource = pathname.replace("/api/export/", "").replace(/\.csv$/, "");
      const rows = csvRows(state, resource);
      if (!rows) return json(res, 404, { error: `unknown export: ${resource}` });
      res.writeHead(200, {
        "Content-Type": "text/csv",
        "Content-Disposition": `attachment; filename="cred402-${resource}.csv"`,
        "Access-Control-Allow-Origin": "*",
      });
      res.end(toCsv(rows));
      return;
    }

    // ---- Prometheus metrics ----
    if (pathname === "/metrics" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4", "Access-Control-Allow-Origin": "*" });
      res.end(renderMetrics(state.ledger) + gateway.httpMetrics() + "\n");
      return;
    }

    // ---- GraphQL live query over SSE (?query=...) ----
    if (pathname === "/graphql/stream" && req.method === "GET") {
      const query = url.searchParams.get("query");
      if (!query) {
        return json(res, 400, { error: "query param required" });
      }
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      const push = async () => {
        const result = await executeGraphQL(state, { query });
        res.write(`event: data\ndata: ${JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}\n\n`);
      };
      await push();
      let pending: NodeJS.Timeout | null = null;
      const unsub = state.ledger.bus.subscribe(() => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          void push();
        }, 800);
      });
      const keepAlive = setInterval(() => res.write(`: ka\n\n`), 15000);
      req.on("close", () => {
        if (pending) clearTimeout(pending);
        clearInterval(keepAlive);
        unsub();
      });
      return;
    }

    // ---- in-browser GraphQL explorer ----
    if (pathname === "/graphiql" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end(GRAPHIQL_HTML);
      return;
    }

    // ---- GraphQL (typed read surface, p2 §7.1) ----
    if (pathname === "/graphql") {
      if (req.method === "GET") {
        const result = await executeGraphQL(state, { query: introspectionQuery });
        return json(res, 200, result);
      }
      if (req.method === "POST") {
        const body = (await readBody(req)) as { query?: string; variables?: Record<string, unknown>; operationName?: string };
        if (!body.query) return json(res, 400, { errors: [{ message: "missing query" }] });
        const result = await executeGraphQL(state, { query: body.query, variables: body.variables, operationName: body.operationName });
        return json(res, result.errors ? 200 : 200, result);
      }
    }

    // ---- x402 paid evidence endpoints ----
    if (pathname.startsWith("/verify/")) {
      await handlePaidEvidence(req, res, state, url);
      return;
    }

    // ---- x402 Credit-Service Marketplace: pay-per-call credit intelligence ----
    if (pathname.startsWith("/x402/services/")) {
      const serviceId = pathname.replace("/x402/services/", "").split("/")[0] ?? "";
      const paymentHeader = typeof req.headers["x-payment"] === "string" ? (req.headers["x-payment"] as string) : undefined;
      const params: Record<string, unknown> = {};
      for (const [k, v] of url.searchParams.entries()) params[k] = v;
      if (req.method === "POST") {
        try {
          Object.assign(params, ((await readBody(req)) as Record<string, unknown>) ?? {});
        } catch {
          return json(res, 400, { error: "malformed JSON body" });
        }
      }
      const decision = await state.callService(serviceId, paymentHeader, params);
      if (decision.kind === "challenge") {
        res.writeHead(402, { ...decision.headers });
        res.end(JSON.stringify(decision.body));
        return;
      }
      if (decision.kind === "rejected") return json(res, decision.status, decision.body);
      return json(res, 200, { result: decision.result, receipt: decision.receipt, payer: decision.payer_agent });
    }

    // ---- SSE event stream ----
    if (pathname === "/api/events/stream") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      const unsub = state.ledger.bus.subscribe((e) => {
        res.write(`event: chain\ndata: ${JSON.stringify(e)}\n\n`);
      });
      const keepAlive = setInterval(() => res.write(`: keep-alive\n\n`), 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        unsub();
      });
      return;
    }

    // ---- REST reads ----
    if (req.method === "GET") {
      switch (pathname) {
        case "/api/health":
          return json(res, 200, { ok: true, policy: state.ledger.policy.version() });
        case "/api/state":
          return json(res, 200, state.ledger.snapshot());
        case "/api/agents":
          return json(res, 200, state.ledger.agents.list());
        case "/api/receipts":
          return json(res, 200, state.ledger.receipts.list());
        case "/api/evidence":
          return json(res, 200, state.ledger.evidence.list());
        case "/api/jobs":
          return json(res, 200, state.ledger.jobs.list());
        case "/api/pool":
          return json(res, 200, {
            ...state.ledger.pool.poolState(),
            estimatedApy: state.ledger.pool.estimatedApy(),
            creditLines: state.ledger.pool.list(),
          });
        case "/api/events":
          return json(res, 200, state.ledger.bus.since(Number(url.searchParams.get("since") ?? 0)));
        case "/api/contracts":
          return json(res, 200, state.ledger.contractHashes);
        case "/api/chain":
          // Canonical Casper Testnet deployment manifest, with cspr.live links,
          // so the console can make on-chain activity observable and verifiable.
          return json(res, 200, loadChainManifest());
        case "/api/alerts":
          return json(res, 200, state.economy.watchdog.alerts);
        case "/api/passports":
          return json(res, 200, state.ledger.agents.list().map((a) => state.ledger.buildPassport(a.agent_id)));
        case "/api/disputes":
          return json(res, 200, state.ledger.disputes.list());
        case "/api/assets":
          return json(res, 200, state.ledger.assets.list());
        case "/api/governance":
          return json(res, 200, { params: state.ledger.governance.get(), history: state.ledger.governance.parameterHistory() });
        case "/api/slashing":
          return json(res, 200, { records: state.ledger.slashing.list(), reserves: state.ledger.slashing.reserveBalances() });
        case "/api/fraud":
          return json(res, 200, state.fraudReports());
        case "/api/multichain":
          return json(res, 200, {
            policyPublicKey: state.ledger.policyPublicKeyHex,
            addressBindings: state.ledger.bindings.list(),
            externalReceipts: state.ledger.externalReceipts.list(),
            globalExposure: state.ledger.exposure.list(),
            creditNotes: state.ledger.notes.list(),
            contractVersions: state.ledger.upgrades.list(),
          });
        case "/api/realfi":
          return json(res, 200, state.realfiState());
        case "/api/flare":
          return json(res, 200, await state.flareView());
        case "/api/keeper":
          return json(res, 200, await state.keeperEvaluateFleet());
        case "/api/automations":
          return json(res, 200, state.automationsView());
        case "/api/collateral":
          return json(res, 200, await state.collateralView());
        case "/api/marketplace/services":
          return json(res, 200, { services: state.listServices(), stats: state.serviceMarketStats(), receipts: state.marketplaceReceipts() });
        case "/api/fassets":
          return json(res, 200, state.fassetsStatus(state.economy.seller.agent_id));
        case "/api/scheduler":
          return json(res, 200, state.schedulerStatus());
        case "/api/x402/facilitator": {
          // Real Casper x402 facilitator status (p9), live when configured.
          const { facilitatorFromEnv } = await import("../lib/x402/index.js");
          const client = facilitatorFromEnv();
          if (!client) return json(res, 200, { configured: false, hint: "set CRED402_X402_FACILITATOR_URL" });
          const healthy = await client.health();
          const supported = healthy ? await client.supported().catch(() => []) : [];
          return json(res, 200, { configured: true, healthy, supported });
        }
        case "/api/economics":
          return json(res, 200, state.economicsView());
        case "/api/marketplace":
          return json(res, 200, state.marketplaceView());
        case "/api/analytics":
          return json(res, 200, state.analytics());
        case "/api/timeseries":
          return json(res, 200, state.timeseries());
        case "/api/lp":
          return json(res, 200, state.lpView());
        case "/api/credit/health":
          return json(res, 200, state.creditHealth());
        case "/api/incidents":
          return json(res, 200, state.incidents());
        case "/api/notifications":
          return json(res, 200, state.notifications());
        case "/api/search":
          return json(res, 200, state.search(url.searchParams.get("q") ?? ""));
      }
      if (req.method === "GET" && pathname.startsWith("/api/credit/explain/")) {
        const agentId = decodeURIComponent(pathname.replace("/api/credit/explain/", ""));
        return json(res, 200, state.creditExplain(agentId));
      }
      if (req.method === "GET" && pathname.startsWith("/api/compliance/")) {
        const agentId = decodeURIComponent(pathname.replace("/api/compliance/", ""));
        return json(res, 200, state.complianceScreen(agentId));
      }
      if (req.method === "GET" && pathname.startsWith("/api/agent-profile/")) {
        const agentId = decodeURIComponent(pathname.replace("/api/agent-profile/", ""));
        return json(res, 200, state.agentProfile(agentId));
      }
      if (req.method === "GET" && pathname.startsWith("/api/credit-report/")) {
        const agentId = decodeURIComponent(pathname.replace("/api/credit-report/", ""));
        return json(res, 200, state.creditReport(agentId));
      }
      if (req.method === "GET" && pathname.startsWith("/api/passport/")) {
        const agentId = decodeURIComponent(pathname.replace("/api/passport/", ""));
        const passport = state.ledger.buildPassport(agentId);
        return passport ? json(res, 200, passport) : json(res, 404, { error: "unknown agent" });
      }
    }

    // ---- mutations ----
    if (req.method === "POST") {
      switch (pathname) {
        case "/api/demo/run":
          return json(res, 200, { scenes: await state.runDemo() });
        case "/api/demo/dispute":
          return json(res, 200, { scenes: await state.runDemo({ dispute: true }) });
        case "/api/demo/multichain":
          return json(res, 200, { scenes: await state.runMultichain() });
        case "/api/demo/realfi":
          return json(res, 200, { scenes: state.runRealFi() });
        case "/api/demo/flare": {
          const b = (await readBody(req)) as { amount_fxrp?: number };
          const amt = Number(b.amount_fxrp ?? 500);
          if (!Number.isFinite(amt) || amt <= 0) return json(res, 400, { error: "amount_fxrp must be a positive finite number" });
          return json(res, 200, await state.runFlareDemo(amt));
        }
        case "/api/demo/keeper":
          return json(res, 200, await state.runKeeperDemo());
        case "/api/demo/automations":
          return json(res, 200, await state.runAutomationsDemo());
        case "/api/demo/collateral":
          return json(res, 200, await state.runCollateralDemo());
        case "/api/demo/buy-service": {
          const b = (await readBody(req)) as { service_id?: string; agent_id?: string };
          const svc = b.service_id ?? "credit-check";
          return json(res, 200, await state.demoBuyService(svc, { agent_id: b.agent_id ?? state.economy.seller.agent_id, monthly_revenue_cspr: 120 }));
        }
        case "/api/demo/fassets": {
          const b = (await readBody(req)) as { xrp?: number };
          return json(res, 200, await state.mintAndCollateralize(state.economy.seller.agent_id, Number(b.xrp ?? 3000)));
        }
        case "/api/scheduler/tick":
          return json(res, 200, await state.schedulerTick());
        case "/api/scheduler/start":
          return json(res, 200, state.schedulerStart());
        case "/api/scheduler/stop":
          return json(res, 200, state.schedulerStop());
        case "/api/x402/buy": {
          const b = (await readBody(req)) as { evidence_type?: string; tampered?: boolean };
          return json(res, 200, await state.x402Buy(b.evidence_type ?? "energy_output", Boolean(b.tampered)));
        }
        case "/api/marketplace/purchase": {
          const b = (await readBody(req)) as { listing_id?: string; buyer_agent?: string };
          if (!b.listing_id || !b.buyer_agent) return json(res, 400, { error: "listing_id + buyer_agent required" });
          return json(res, 200, state.marketplacePurchase(b.listing_id, b.buyer_agent));
        }
        case "/api/credit/deposit": {
          const b = (await readBody(req)) as { amount_cspr?: number };
          return json(res, 200, state.mDeposit(Number(b.amount_cspr ?? 100)));
        }
        case "/api/realfi/verify-operator": {
          const b = (await readBody(req)) as {
            operator_id?: string;
            verification_level?: "unverified" | "email_verified" | "business_verified" | "regulated_entity";
            jurisdiction?: string;
            verification_reference?: string;
          };
          if (!b.operator_id) return json(res, 400, { error: "operator_id required" });
          const r = state.realfi.verifyOperator({
            operator_id: b.operator_id,
            verification_level: b.verification_level ?? "business_verified",
            jurisdiction: b.jurisdiction ?? "US",
            verification_reference: b.verification_reference ?? `idv_${Date.now()}`,
          });
          return json(res, 200, { ok: true, attestation_hash: r.attestation_hash, record: r.record });
        }
        case "/api/realfi/fiat-receipt": {
          const b = (await readBody(req)) as {
            seller_agent?: string;
            operator_id?: string;
            amount?: string;
            currency?: string;
            service_type?: string;
            provider_event_id?: string;
            provider_receipt_id?: string;
          };
          if (!b.seller_agent || !b.operator_id) return json(res, 400, { error: "seller_agent + operator_id required" });
          const r = state.realfi.recordFiatReceipt({
            provider_event_id: b.provider_event_id ?? `evt_${Date.now()}`,
            provider_receipt_id: b.provider_receipt_id ?? `ch_${Date.now()}`,
            payer_type: "enterprise_customer",
            seller_agent: b.seller_agent,
            operator_id: b.operator_id,
            amount: b.amount ?? "100.00",
            currency: b.currency ?? "USD",
            service_type: b.service_type ?? "rwa.weather_risk",
            request_hash: "0xreq",
            result_hash: "0xres",
          });
          return json(res, 200, { ok: true, receipt_id: r.receipt_id, record: r.record });
        }
        case "/api/realfi/chargeback": {
          const b = (await readBody(req)) as { operator_id?: string; dispute_reference?: string };
          if (!b.operator_id) return json(res, 400, { error: "operator_id required" });
          const rec = state.realfi.recordChargeback({ operator_id: b.operator_id, dispute_reference: b.dispute_reference ?? `dp_${Date.now()}` });
          return json(res, 200, { ok: true, record: rec });
        }
        case "/api/realfi/stripe-webhook": {
          // Real Stripe webhook (p10): raw body + signature → verified event → on-chain.
          const secret = process.env.STRIPE_WEBHOOK_SECRET;
          const apiKey = process.env.STRIPE_SECRET_KEY;
          if (!secret || !apiKey) return json(res, 503, { error: "stripe not configured (set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET)" });
          const sig = req.headers["stripe-signature"];
          if (typeof sig !== "string") return json(res, 400, { error: "missing Stripe-Signature header" });
          const raw = await readRawBody(req);
          const { stripeClient, handleStripeWebhook } = await import("../lib/realfi/stripe.js");
          try {
            const result = handleStripeWebhook({
              bridge: state.realfi,
              stripe: stripeClient(apiKey),
              rawBody: raw,
              signatureHeader: sig,
              endpointSecret: secret,
            });
            return json(res, 200, { ok: true, ...result });
          } catch (err) {
            return json(res, 400, { error: `webhook rejected: ${(err as Error).message}` });
          }
        }
        case "/api/realfi/verify-bank": {
          // Real Plaid sandbox bank verification (p10) → on-chain Bank Verification Envelope.
          const b = (await readBody(req)) as { operator_id?: string; institution_id?: string };
          if (!b.operator_id) return json(res, 400, { error: "operator_id required" });
          const { plaidFromEnv } = await import("../lib/realfi/plaid.js");
          const plaid = plaidFromEnv();
          if (!plaid) return json(res, 503, { error: "plaid not configured (set PLAID_CLIENT_ID + PLAID_SECRET)" });
          const r = await plaid.verifyAndCommit(state.realfi, b.operator_id, b.institution_id);
          return json(res, 200, { ok: true, attestation_hash: r.attestation_hash, record: r.record });
        }
        case "/api/demo/reset":
          state.reset();
          state.economy.bootstrap();
          state.economy.createJob();
          return json(res, 200, { ok: true });
        case "/api/policy/upgrade": {
          const body = (await readBody(req)) as { version?: string };
          state.ledger.policy.upgrade(body.version ?? "v2");
          return json(res, 200, { ok: true, version: state.ledger.policy.version() });
        }
        case "/api/disputes/open": {
          const b = (await readBody(req)) as { dispute_type?: string; respondent_agent?: string; note?: string; receipt_id?: string };
          const d = state.ledger.disputes.open({
            dispute_type: (b.dispute_type as never) ?? "bad_evidence",
            complainant: "console.operator",
            respondent_agent: b.respondent_agent ?? "EvidenceSellerAgent",
            receipt_id: b.receipt_id,
            note: b.note ?? "opened from console",
            evidence_hash: "0x" + "00".repeat(32),
          });
          return json(res, 200, d);
        }
        case "/api/governance/param": {
          const b = (await readBody(req)) as { key?: string; value?: unknown };
          if (!b.key) return json(res, 400, { error: "key required" });
          // coerce booleans/numbers/bigints from the console
          let value: unknown = b.value;
          if (b.key.startsWith("paused_")) value = Boolean(b.value);
          else if (b.key === "max_agent_exposure") value = BigInt(String(b.value));
          else if (typeof b.value === "string" && /^\d+$/.test(b.value)) value = Number(b.value);
          state.ledger.governance.set_param(b.key as never, value as never);
          return json(res, 200, { ok: true, params: state.ledger.governance.get() });
        }
        case "/api/governance/pause": {
          const b = (await readBody(req)) as { area?: "credit_draws" | "registrations" | "receipt_finalization"; on?: boolean };
          const area = b.area ?? "credit_draws";
          if (b.on === false) state.ledger.governance.unpause(area);
          else state.ledger.governance.pause(area);
          return json(res, 200, { ok: true, params: state.ledger.governance.get() });
        }
      }
    }

    // ---- static frontend ----
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      const served = await serveStatic(res, pathname);
      if (served) return;
      json(res, 200, {
        message: "Cred402 API is running. Build the dashboard with `cd frontend && npm install && npm run build`, or run it in dev with `npm run dev`.",
        endpoints: ["/api/state", "/api/events/stream", "POST /api/demo/run"],
      });
      return;
    }

    json(res, 404, { error: `no route for ${req.method} ${pathname}` });
  } catch (err) {
    // Translate a typed ApiError to its status (validation → 400/404), else 500.
    const apiErr = toApiError(err);
    json(res, apiErr.status, { error: apiErr.message, code: apiErr.code });
  }
});

server.listen(PORT, () => {
  gateway.log.info("cred402 api listening", { port: PORT, env: gateway.config.env, auth: gateway.config.authRequired });
  if (gateway.bootstrapAdminKey) {
    // Shown once at startup so the operator can mint scoped keys; not persisted.
    gateway.log.warn("bootstrap admin api key (store securely, shown once)", { key: gateway.bootstrapAdminKey });
  }
  console.log(`Cred402 API listening on http://localhost:${PORT}`);
  console.log(`  console (unversioned):   http://localhost:${PORT}/api/state`);
  console.log(`  production API (v1):      http://localhost:${PORT}/v1/health`);
  console.log(`  graphql + explorer:       http://localhost:${PORT}/graphql · /graphiql`);
  console.log(`  prometheus metrics:       http://localhost:${PORT}/metrics`);
  console.log(`  public credit report:     http://localhost:${PORT}/report/EvidenceSellerAgent`);
  console.log(`  csv export:               http://localhost:${PORT}/api/export/agents.csv`);
  console.log(`  x402 paid endpoint:       curl -s "http://localhost:${PORT}/verify/energy_output?rwa_id=SOLAR-A17"`);
});
