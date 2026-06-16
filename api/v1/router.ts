import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServerState } from "../state.js";
import {
  Gateway,
  ok,
  fail,
  toApiError,
  ApiError,
  RateLimitError,
  parse,
  v,
  type Scope,
} from "../../lib/gateway/index.js";

/**
 * Cred402 public REST API v1 (p2 §7.1).
 *
 * The production gateway surface: every route runs auth (scoped API keys) →
 * rate limiting → body validation → idempotency (mutations) → handler →
 * consistent {@link ok}/{@link fail} envelope, with a request id and structured
 * access log. This is the externally-versioned API; the console keeps using the
 * unversioned `/api/*` routes.
 */
export class V1Router {
  constructor(
    private readonly gateway: Gateway,
    private readonly state: ServerState,
  ) {}

  /** Returns true if it handled the request. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    if (!path.startsWith("/v1/") && path !== "/v1") return false;

    const requestId = this.gateway.newRequestId();
    const clientIp = (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
    const method = req.method ?? "GET";
    const routeLabel = `${method} /${path.split("/").filter(Boolean).slice(0, 2).join("/")}`;
    const apiKey = extractApiKey(req);
    const log = this.gateway.log.child({ request_id: requestId, method, path, ip: clientIp });
    const started = Date.now();

    try {
      const route = this.match(method, path);
      if (!route) throw new ApiError(404, "not_found", `no route for ${method} ${path}`);

      const auth = this.gateway.authenticate(apiKey, clientIp, route.scope);
      const rl = this.gateway.enforceRateLimit(auth.identity);
      const rlHeaders = { "X-RateLimit-Limit": String(rl.limit), "X-RateLimit-Remaining": String(rl.remaining) };

      const body = method === "POST" ? await readJson(req) : {};
      // Idempotency for mutations carrying an Idempotency-Key header.
      const idemKey = header(req, "idempotency-key");
      if (method === "POST" && idemKey) {
        const fp = this.gateway.fingerprint(body);
        const hit = this.gateway.idempotency.get(idemKey, fp);
        if (hit) {
          log.info("idempotent replay", { status: hit.status, key_id: auth.key?.id });
          return send(res, hit.status, hit.body, requestId, rlHeaders);
        }
        const result = await route.run({ params: route.params, body, url });
        this.gateway.idempotency.put(idemKey, fp, 200, ok(result, requestId));
        log.info("ok", { status: 200, key_id: auth.key?.id, ms: Date.now() - started });
        this.gateway.recordHttp(routeLabel, 200);
        return send(res, 200, ok(result, requestId), requestId, rlHeaders);
      }

      const result = await route.run({ params: route.params, body, url });
      log.info("ok", { status: 200, key_id: auth.key?.id, ms: Date.now() - started });
      this.gateway.recordHttp(routeLabel, 200);
      return send(res, 200, ok(result, requestId), requestId, rlHeaders);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) log.error("request failed", { status: apiErr.status, error: apiErr.message });
      else log.warn("request rejected", { status: apiErr.status, code: apiErr.code });
      this.gateway.recordHttp(routeLabel, apiErr.status);
      const headers: Record<string, string> = {};
      if (apiErr instanceof RateLimitError) headers["Retry-After"] = String(Math.ceil(apiErr.retryAfterMs / 1000));
      return send(res, apiErr.status, fail(apiErr.code, apiErr.message, requestId), requestId, headers);
    }
  }

  // -- routing -------------------------------------------------------------

  private match(
    method: string,
    path: string,
  ): { scope: Scope; params: Record<string, string>; run: (ctx: Ctx) => unknown | Promise<unknown> } | undefined {
    const s = this.state;
    const seg = path.split("/").filter(Boolean); // ["v1", ...]

    const R = (
      m: string,
      pattern: string,
      scope: Scope,
      run: (ctx: Ctx) => unknown | Promise<unknown>,
    ) => {
      if (method !== m) return undefined;
      const pp = pattern.split("/").filter(Boolean);
      if (pp.length !== seg.length) return undefined;
      const params: Record<string, string> = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i]!.startsWith(":")) params[pp[i]!.slice(1)] = decodeURIComponent(seg[i]!);
        else if (pp[i] !== seg[i]) return undefined;
      }
      return { scope, params, run };
    };

    return (
      R("GET", "v1/health", "read", () => ({ ok: true, env: this.gateway.config.env, policy: s.ledger.policy.version() })) ??
      R("POST", "v1/auth/wallet/challenge", "read", ({ body }) => {
        const b = parse(v.object({ account: v.string({ min: 66, max: 66 }) }), body);
        return s.walletChallenge(b.account);
      }) ??
      R("POST", "v1/auth/wallet/verify", "read", ({ body }) => {
        const b = parse(v.object({ nonce: v.string({ min: 8 }), signature: v.string({ min: 8 }) }), body);
        return s.walletVerify(b.nonce, b.signature);
      }) ??
      R("GET", "v1/auth/wallet/agents", "read", ({ url }) => {
        const token = url.searchParams.get("token") ?? "";
        if (!token) throw new ApiError(400, "bad_request", "token query parameter required");
        return s.walletAgents(token);
      }) ??
      R("GET", "v1/agents", "read", ({ url }) => {
        let list = s.ledger.agents.list();
        const svc = url.searchParams.get("service_type");
        if (svc) list = list.filter((a) => a.service_type === svc);
        const minRep = url.searchParams.get("min_reputation");
        if (minRep) list = list.filter((a) => a.reputation_score >= Number(minRep));
        return paginate(list, url);
      }) ??
      R("GET", "v1/agents/compare", "read", ({ url }) => {
        const a = url.searchParams.get("a");
        const b = url.searchParams.get("b");
        if (!a || !b) throw new ApiError(400, "bad_request", "both ?a= and ?b= agent ids are required");
        return s.compareAgents(a, b);
      }) ??
      R("GET", "v1/agents/:id", "read", ({ params }) => required(s.ledger.agents.get(params.id!), "agent")) ??
      R("GET", "v1/agents/:id/passport", "read", ({ params }) => required(s.ledger.buildPassport(params.id!), "agent")) ??
      R("GET", "v1/agents/:id/credit-line", "read", ({ params }) => required(s.ledger.pool.get(params.id!), "credit line")) ??
      R("GET", "v1/agents/:id/credit-explain", "read", ({ params }) => s.creditExplain(params.id!)) ??
      R("GET", "v1/compliance/agents/:id", "read", ({ params }) => s.complianceScreen(params.id!)) ??
      R("GET", "v1/compliance/report", "read", () => s.complianceReport()) ??
      R("GET", "v1/agents/:id/profile", "read", ({ params }) => s.agentProfile(params.id!)) ??
      R("POST", "v1/agents/:id/capabilities", "write", ({ params, body }) => {
        const b = parse(v.object({ capabilities: v.array(v.string(), { max: 32 }), spending_limit_cspr: v.optional(v.number({ min: 0 })) }), body);
        return s.setCapabilities(params.id!, b.capabilities, b.spending_limit_cspr);
      }) ??
      R("GET", "v1/agents/:id/credit-report", "read", ({ params }) => s.creditReport(params.id!)) ??
      R("GET", "v1/agents/:id/tier", "read", ({ params }) => s.tier(params.id!)) ??
      R("GET", "v1/tiers", "read", () => s.tiers()) ??
      R("GET", "v1/credit/portfolio", "read", () => s.portfolioReport()) ??
      R("GET", "v1/risk/alerts", "read", () => s.riskAlerts()) ??
      R("GET", "v1/credit/yield-projection", "read", () => s.yieldProjection()) ??
      R("GET", "v1/credit/offers", "read", ({ url }) => s.listCreditOffers(url.searchParams.get("agent_id") ?? undefined)) ??
      R("POST", "v1/credit/offers", "write", ({ body }) => {
        const b = parse(
          v.object({
            agent_id: v.string({ min: 2, max: 64 }),
            ttl_seconds: v.optional(v.number({ min: 60 })),
            term_seconds: v.optional(v.number({ min: 60 })),
          }),
          body,
        );
        return s.issueCreditOffer(b.agent_id, { ttl_seconds: b.ttl_seconds, term_seconds: b.term_seconds });
      }) ??
      R("POST", "v1/credit/offers/:id/accept", "write", ({ params }) => s.acceptCreditOffer(params.id!)) ??
      R("POST", "v1/credit/offers/:id/decline", "write", ({ params }) => s.declineCreditOffer(params.id!)) ??
      R("POST", "v1/credit/simulate", "read", ({ body }) => {
        const b = parse(
          v.object({
            monthly_revenue_cspr: v.number({ min: 0 }),
            stake_cspr: v.optional(v.number({ min: 0 })),
            reputation: v.optional(v.number({ min: 0, max: 100 })),
            accuracy: v.optional(v.number({ min: 0, max: 100 })),
            dispute_rate: v.optional(v.number({ min: 0, max: 1 })),
            jobs_completed: v.optional(v.number({ min: 0 })),
            service_type: v.optional(v.string({ max: 64 })),
          }),
          body,
        );
        return s.simulateCredit(b);
      }) ??
      R("GET", "v1/analytics/categories", "read", () => s.categoryAnalytics()) ??
      R("GET", "v1/analytics/reputation-movers", "read", ({ url }) => s.reputationMovers(numParam(url, "limit"))) ??
      R("GET", "v1/discovery", "read", ({ url }) =>
        s.discover({
          service_type: url.searchParams.get("service_type") ?? undefined,
          min_reputation: numParam(url, "min_reputation"),
          min_score: numParam(url, "min_score"),
          limit: numParam(url, "limit"),
        }),
      ) ??
      R("GET", "v1/attestations/graph", "read", () => s.attestationGraph()) ??
      R("GET", "v1/agents/:id/attestations", "read", ({ params }) => s.attestationsFor(params.id!)) ??
      R("GET", "v1/agents/:id/benchmark", "read", ({ params }) => s.peerBenchmark(params.id!)) ??
      R("GET", "v1/agents/:id/history", "read", ({ params }) => s.creditHistory(params.id!)) ??
      R("GET", "v1/agents/:id/readiness", "read", ({ params }) => s.onboardingScorecard(params.id!)) ??
      R("GET", "v1/agents/:id/score-trend", "read", ({ params }) => s.scoreTrend(params.id!)) ??
      R("GET", "v1/agents/:id/multichain", "read", ({ params }) => s.agentMultichain(params.id!)) ??
      R("GET", "v1/agents/:id/health", "read", ({ params }) => s.agentHealth(params.id!)) ??
      R("POST", "v1/attestations", "write", ({ body }) => {
        const b = parse(v.object({ from: v.string({ min: 2 }), to: v.string({ min: 2 }), note: v.withDefault(v.string({ max: 200 }), "") }), body);
        return s.attest(b.from, b.to, b.note);
      }) ??
      R("POST", "v1/agents", "write", ({ body }) => {
        const a = parse(
          v.object({
            agent_id: v.string({ min: 2, max: 64 }),
            service_type: v.literalUnion(
              "solar_output_verification",
              "weather_risk",
              "receivable_quality",
              "risk_scoring",
              "treasury_routing",
              "monitoring",
            ),
            agent_public_key: v.withDefault(v.string({ max: 130 }), "01"),
            owner_public_key: v.withDefault(v.string({ max: 130 }), "01"),
          }),
          body,
        );
        s.ledger.agents.register_agent(a);
        return s.ledger.buildPassport(a.agent_id);
      }) ??
      R("GET", "v1/receipts", "read", ({ url }) => {
        let list = s.ledger.receipts.list();
        const status = url.searchParams.get("status");
        if (status) list = list.filter((r) => r.status === status);
        const seller = url.searchParams.get("seller");
        if (seller) list = list.filter((r) => r.seller_agent === seller);
        return paginate(list, url);
      }) ??
      R("GET", "v1/x402/receipts/:id", "read", ({ params }) => required(s.ledger.receipts.get(params.id!), "receipt")) ??
      R("GET", "v1/credit/pool", "read", () => ({ ...s.ledger.pool.poolState(), creditLines: s.ledger.pool.list() })) ??
      R("POST", "v1/credit/deposit", "write", ({ body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.mDeposit(b.amount_cspr);
      }) ??
      R("POST", "v1/credit/withdraw", "write", ({ body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.mWithdraw(b.amount_cspr);
      }) ??
      R("GET", "v1/governance/proposals", "read", () => s.governanceProposals.list()) ??
      R("POST", "v1/governance/proposals", "write", ({ body }) => {
        const b = parse(
          v.object({
            title: v.string({ min: 3, max: 200 }),
            param_key: v.string({ min: 2 }),
            new_value: v.number(),
            proposer: v.string({ min: 2 }),
          }),
          body,
        );
        return s.governanceProposals.create(b);
      }) ??
      R("POST", "v1/governance/proposals/:id/vote", "write", ({ params, body }) => {
        const b = parse(v.object({ agent_id: v.string({ min: 2 }), support: v.boolean() }), body);
        return s.governanceProposals.vote(params.id!, b.agent_id, b.support);
      }) ??
      R("POST", "v1/governance/proposals/:id/execute", "admin", ({ params }) => s.governanceProposals.execute(params.id!)) ??
      R("POST", "v1/governance/proposals/:id/apply", "admin", ({ params }) => s.governanceProposals.apply(params.id!)) ??
      R("GET", "v1/economics", "read", () => s.economicsView()) ??
      R("GET", "v1/credit/lp", "read", () => s.lpView()) ??
      R("GET", "v1/credit/health", "read", () => s.creditHealth()) ??
      R("GET", "v1/credit/stress-test", "read", () => s.stressTest()) ??
      R("POST", "v1/credit/lines/:id/freeze", "admin", ({ params, body }) => {
        const b = parse(v.object({ reason: v.withDefault(v.string({ max: 200 }), "risk freeze") }), body);
        return s.freezeLine(params.id!, b.reason);
      }) ??
      R("GET", "v1/marketplace", "read", () => s.marketplaceView()) ??
      R("POST", "v1/marketplace/listings", "write", ({ body }) => {
        const b = parse(
          v.object({
            agent_id: v.string({ min: 2 }),
            category: v.string({ min: 3 }),
            strategy: v.optional(v.literalUnion("fixed", "dynamic", "auction", "subscription", "reputation_tiered", "urgency", "data_cost_plus")),
            base_price_cspr: v.number({ min: 0 }),
          }),
          body,
        );
        return s.createListing(b);
      }) ??
      R("POST", "v1/marketplace/purchase", "write", ({ body }) => {
        const b = parse(v.object({ listing_id: v.string({ min: 1 }), buyer_agent: v.string({ min: 1 }) }), body);
        return s.marketplacePurchase(b.listing_id, b.buyer_agent);
      }) ??
      R("GET", "v1/analytics", "read", () => s.analytics()) ??
      R("GET", "v1/notifications", "read", () => s.notifications()) ??
      R("GET", "v1/search", "read", ({ url }) => s.search(url.searchParams.get("q") ?? "")) ??
      R("POST", "v1/credit/lines", "write", ({ body }) => {
        const b = parse(v.object({ agent_id: v.string({ min: 2 }), term_days: v.optional(v.number({ int: true, min: 1, max: 365 })) }), body);
        const { decision, line } = s.economy.credit.underwrite(b.agent_id, { term_days: b.term_days });
        return { decision, line };
      }) ??
      R("POST", "v1/operators/fleet-overview", "read", ({ body }) => {
        const b = parse(v.object({ agent_ids: v.array(v.string({ min: 2 }), { max: 200 }) }), body);
        return s.fleetOverview(b.agent_ids);
      }) ??
      R("POST", "v1/credit/underwrite-batch", "write", ({ body }) => {
        const b = parse(v.object({ agent_ids: v.array(v.string({ min: 2 }), { max: 100 }) }), body);
        return b.agent_ids.map((id) => {
          try {
            const { decision, line } = s.economy.credit.underwrite(id);
            return { agent_id: id, ok: true, credit_line: line.max_credit.toString(), credit_score: decision.credit_score };
          } catch (err) {
            return { agent_id: id, ok: false, error: (err as Error).message };
          }
        });
      }) ??
      R("POST", "v1/credit/review-all", "admin", () => s.reviewAllCreditLines()) ??
      R("POST", "v1/credit/lines/:id/review", "write", ({ params }) => s.reviewCreditLine(params.id!)) ??
      R("POST", "v1/credit/lines/:id/draw", "write", ({ params, body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.economy.treasury.fundDraw(params.id!, b.amount_cspr);
      }) ??
      R("POST", "v1/credit/lines/:id/repay", "write", ({ params, body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.economy.treasury.collectRepayment(params.id!, b.amount_cspr);
      }) ??
      R("POST", "v1/agents/:id/stake", "write", ({ params, body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.mStake(params.id!, b.amount_cspr);
      }) ??
      R("POST", "v1/disputes", "write", ({ body }) => {
        const b = parse(
          v.object({
            respondent_agent: v.string({ min: 2 }),
            dispute_type: v.withDefault(v.literalUnion("bad_evidence", "fake_receipt", "non_delivery", "agent_default", "collusion"), "bad_evidence"),
            receipt_id: v.optional(v.string()),
            note: v.withDefault(v.string({ max: 500 }), "opened via v1 API"),
          }),
          body,
        );
        return s.ledger.disputes.open({
          dispute_type: b.dispute_type,
          complainant: "api.v1",
          respondent_agent: b.respondent_agent,
          receipt_id: b.receipt_id,
          note: b.note,
          evidence_hash: "0x" + "00".repeat(32),
        });
      }) ??
      R("POST", "v1/admin/advance-clock", "admin", ({ body }) => {
        const b = parse(v.object({ seconds: v.number({ min: 1, max: 31_536_000 }) }), body);
        return s.advanceClock(b.seconds);
      }) ??
      R("POST", "v1/reputation/decay", "admin", ({ body }) => {
        const b = parse(v.object({ assume_inactive_days: v.optional(v.number({ min: 0 })) }), body);
        return s.applyDecay(b.assume_inactive_days);
      }) ??
      R("POST", "v1/insurance/claim", "write", ({ body }) => {
        const b = parse(v.object({ claimant: v.string({ min: 1 }), amount_cspr: v.number({ min: 0 }), reason: v.withDefault(v.string({ max: 200 }), "insurance claim") }), body);
        return s.mClaimInsurance(b.claimant, b.amount_cspr, b.reason);
      }) ??
      R("POST", "v1/disputes/:id/verdict", "write", ({ params, body }) => {
        const b = parse(
          v.object({
            verdict: v.literalUnion("agent_wins", "agent_loses", "partial_fault", "inconclusive", "malicious_dispute"),
            slash_cspr: v.withDefault(v.number({ min: 0 }), 0),
          }),
          body,
        );
        return s.mResolveDispute(params.id!, b.verdict, b.slash_cspr);
      }) ??
      R("GET", "v1/realfi", "read", () => s.realfiState()) ??
      R("POST", "v1/realfi/operators", "write", ({ body }) => {
        const b = parse(
          v.object({
            operator_id: v.string({ min: 2 }),
            verification_level: v.withDefault(v.literalUnion("unverified", "email_verified", "business_verified", "regulated_entity"), "business_verified"),
            jurisdiction: v.withDefault(v.string({ min: 2, max: 2 }), "US"),
            verification_reference: v.string({ min: 1 }),
          }),
          body,
        );
        return s.realfi.verifyOperator(b);
      }) ??
      R("POST", "v1/realfi/fiat-receipts", "write", ({ body }) => {
        const b = parse(
          v.object({
            seller_agent: v.string({ min: 2 }),
            operator_id: v.string({ min: 2 }),
            amount: v.decimalString(),
            currency: v.withDefault(v.string({ min: 3, max: 3 }), "USD"),
            service_type: v.withDefault(v.string(), "rwa.weather_risk"),
            provider_event_id: v.string({ min: 1 }),
            provider_receipt_id: v.string({ min: 1 }),
          }),
          body,
        );
        return s.realfi.recordFiatReceipt({ ...b, payer_type: "enterprise_customer", request_hash: "0xreq", result_hash: "0xres" });
      }) ??
      // -- admin -----------------------------------------------------------
      R("GET", "v1/admin/api-keys", "admin", () => this.gateway.apiKeys.list()) ??
      R("POST", "v1/admin/api-keys", "admin", ({ body }) => {
        const b = parse(
          v.object({ name: v.string({ min: 1, max: 64 }), scopes: v.array(v.literalUnion("read", "write", "admin"), { max: 3 }) }),
          body,
        );
        return this.gateway.apiKeys.issue(b.name, b.scopes);
      }) ??
      R("GET", "v1/webhooks", "admin", () => this.gateway.webhooks.list()) ??
      R("GET", "v1/webhooks/deliveries", "admin", ({ url }) => this.gateway.webhooks.deliveries(url.searchParams.get("subscription_id") ?? undefined)) ??
      R("POST", "v1/webhooks", "admin", ({ body }) => {
        const b = parse(v.object({ url: v.string({ min: 8 }), events: v.withDefault(v.array(v.string(), { max: 50 }), ["*"]), agent_filter: v.optional(v.string()) }), body);
        return this.gateway.webhooks.subscribe(b.url, b.events, b.agent_filter);
      }) ??
      undefined
    );
  }
}

interface Ctx {
  params: Record<string, string>;
  body: unknown;
  url: URL;
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null) throw new ApiError(404, "not_found", `${what} not found`);
  return value;
}

/**
 * Apply ?limit=&offset= by slicing — returns the same ARRAY shape clients/SDKs
 * already expect (no envelope change). Default limit is generous so unparam'd
 * calls return everything; pass limit/offset to page.
 */
function paginate<T>(items: T[], url: URL): T[] {
  const limit = clampInt(url.searchParams.get("limit"), 500, 1, 1000);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
  return items.slice(offset, offset + limit);
}

/** Parse an optional numeric query param; returns undefined when absent/invalid. */
function numParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const h = req.headers[name];
  return Array.isArray(h) ? h[0] : h;
}

function extractApiKey(req: IncomingMessage): string | undefined {
  const auth = header(req, "authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  return header(req, "x-api-key");
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_json", "request body is not valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown, requestId: string, extra: Record<string, string> = {}): true {
  const payload = JSON.stringify(body, (_k, v2) => (typeof v2 === "bigint" ? v2.toString() : v2));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, Idempotency-Key",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...extra,
  });
  res.end(payload);
  return true;
}
