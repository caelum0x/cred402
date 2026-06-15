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
    const apiKey = extractApiKey(req);
    const log = this.gateway.log.child({ request_id: requestId, method, path, ip: clientIp });
    const started = Date.now();

    try {
      const route = this.match(method, path);
      if (!route) throw new ApiError(404, "not_found", `no route for ${method} ${path}`);

      const auth = this.gateway.authenticate(apiKey, clientIp, route.scope);
      this.gateway.enforceRateLimit(auth.identity);

      const body = method === "POST" ? await readJson(req) : {};
      // Idempotency for mutations carrying an Idempotency-Key header.
      const idemKey = header(req, "idempotency-key");
      if (method === "POST" && idemKey) {
        const fp = this.gateway.fingerprint(body);
        const hit = this.gateway.idempotency.get(idemKey, fp);
        if (hit) {
          log.info("idempotent replay", { status: hit.status, key_id: auth.key?.id });
          return send(res, hit.status, hit.body, requestId);
        }
        const result = await route.run({ params: route.params, body, url });
        this.gateway.idempotency.put(idemKey, fp, 200, ok(result, requestId));
        log.info("ok", { status: 200, key_id: auth.key?.id, ms: Date.now() - started });
        return send(res, 200, ok(result, requestId), requestId);
      }

      const result = await route.run({ params: route.params, body, url });
      log.info("ok", { status: 200, key_id: auth.key?.id, ms: Date.now() - started });
      return send(res, 200, ok(result, requestId), requestId);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) log.error("request failed", { status: apiErr.status, error: apiErr.message });
      else log.warn("request rejected", { status: apiErr.status, code: apiErr.code });
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
      R("GET", "v1/agents", "read", () => s.ledger.agents.list()) ??
      R("GET", "v1/agents/:id", "read", ({ params }) => required(s.ledger.agents.get(params.id!), "agent")) ??
      R("GET", "v1/agents/:id/passport", "read", ({ params }) => required(s.ledger.buildPassport(params.id!), "agent")) ??
      R("GET", "v1/agents/:id/credit-line", "read", ({ params }) => required(s.ledger.pool.get(params.id!), "credit line")) ??
      R("GET", "v1/agents/:id/credit-explain", "read", ({ params }) => s.creditExplain(params.id!)) ??
      R("GET", "v1/compliance/agents/:id", "read", ({ params }) => s.complianceScreen(params.id!)) ??
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
      R("GET", "v1/receipts", "read", () => s.ledger.receipts.list()) ??
      R("GET", "v1/x402/receipts/:id", "read", ({ params }) => required(s.ledger.receipts.get(params.id!), "receipt")) ??
      R("GET", "v1/credit/pool", "read", () => ({ ...s.ledger.pool.poolState(), creditLines: s.ledger.pool.list() })) ??
      R("GET", "v1/economics", "read", () => s.economicsView()) ??
      R("GET", "v1/marketplace", "read", () => s.marketplaceView()) ??
      R("POST", "v1/credit/lines", "write", ({ body }) => {
        const b = parse(v.object({ agent_id: v.string({ min: 2 }), term_days: v.optional(v.number({ int: true, min: 1, max: 365 })) }), body);
        const { decision, line } = s.economy.credit.underwrite(b.agent_id, { term_days: b.term_days });
        return { decision, line };
      }) ??
      R("POST", "v1/credit/lines/:id/draw", "write", ({ params, body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.economy.treasury.fundDraw(params.id!, b.amount_cspr);
      }) ??
      R("POST", "v1/credit/lines/:id/repay", "write", ({ params, body }) => {
        const b = parse(v.object({ amount_cspr: v.number({ min: 0 }) }), body);
        return s.economy.treasury.collectRepayment(params.id!, b.amount_cspr);
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
      R("POST", "v1/webhooks", "admin", ({ body }) => {
        const b = parse(v.object({ url: v.string({ min: 8 }), events: v.withDefault(v.array(v.string(), { max: 50 }), ["*"]) }), body);
        return this.gateway.webhooks.subscribe(b.url, b.events);
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
