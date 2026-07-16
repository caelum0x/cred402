import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, normalize } from "node:path";
import { getState } from "./state.js";
import { handlePaidEvidence } from "./paid_evidence_server/index.js";
import { Gateway, loadConfig } from "../lib/gateway/index.js";
import { V1Router } from "./v1/router.js";
import { executeGraphQL, introspectionQuery } from "../lib/graphql/index.js";
import { GRAPHIQL_HTML } from "../lib/graphql/explorer_html.js";
import { renderMetrics } from "../lib/gateway/metrics.js";
import { toCsv } from "../lib/services/csv.js";
import { loadChainManifest } from "../lib/services/chain_manifest.js";
import { renderCreditReportHtml } from "../lib/services/report_html.js";
import type { CreditReport } from "../lib/services/credit_report.js";

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
const FRONTEND_DIR = resolve(process.cwd(), "frontend", "dist");

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Payment",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Raw request body — required for Stripe webhook HMAC signature verification. */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  try {
    let rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(resolve(FRONTEND_DIR, "." + rel));
    if (!filePath.startsWith(FRONTEND_DIR)) return false; // path traversal guard
    const s = await stat(filePath).catch(() => null);
    const target = s?.isFile() ? filePath : resolve(FRONTEND_DIR, "index.html"); // SPA fallback
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

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
    json(res, 500, { error: (err as Error).message });
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
