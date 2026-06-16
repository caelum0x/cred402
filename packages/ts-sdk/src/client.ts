import { Cred402Error } from "./errors.js";
import type {
  Agent, CreditExplain, CreditLine, MarketListing, IssuedApiKey, WebhookSubscription, Scope, ServiceType,
} from "./types.js";

export interface Cred402ClientOptions {
  baseUrl?: string;
  apiKey?: string;
  fetchFn?: typeof fetch;
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
  request_id?: string;
}

/**
 * Cred402Client — the official TypeScript client for the production `/v1` API.
 *
 * Isomorphic (uses global `fetch`). Unwraps the success/error envelope, attaches
 * bearer auth, and supports per-call idempotency keys on mutations. Every method
 * maps to a real `/v1` route.
 */
export class Cred402Client {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: Cred402ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:4021").replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const env = (await res.json()) as Envelope<T>;
    if (!env.success) {
      throw new Cred402Error(env.error?.code ?? "error", env.error?.message ?? "request failed", res.status, env.request_id);
    }
    return env.data as T;
  }

  // -- system -------------------------------------------------------------
  protocolConfig(): Promise<unknown> {
    return this.request("GET", "/v1/config");
  }
  health(): Promise<{ ok: boolean; env: string; policy: string }> {
    return this.request("GET", "/v1/health");
  }

  // -- agents -------------------------------------------------------------
  listAgents(): Promise<Agent[]> {
    return this.request("GET", "/v1/agents");
  }
  getAgent(id: string): Promise<Agent> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}`);
  }
  getPassport(id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}/passport`);
  }
  getCreditLine(id: string): Promise<CreditLine> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}/credit-line`);
  }
  explainCredit(id: string): Promise<CreditExplain> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(id)}/credit-explain`);
  }
  registerAgents(agents: Array<{ agent_id: string; service_type: ServiceType }>): Promise<unknown> {
    return this.request("POST", "/v1/agents/batch", { agents });
  }
  registerAgent(agent_id: string, service_type: ServiceType, agent_public_key?: string): Promise<unknown> {
    return this.request("POST", "/v1/agents", { agent_id, service_type, agent_public_key }, agent_id);
  }
  screenCompliance(id: string): Promise<unknown> {
    return this.request("GET", `/v1/compliance/agents/${encodeURIComponent(id)}`);
  }

  // -- credit -------------------------------------------------------------
  creditPool(): Promise<unknown> {
    return this.request("GET", "/v1/credit/pool");
  }
  openCreditLine(agent_id: string, term_days?: number): Promise<{ decision: unknown; line: CreditLine }> {
    return this.request("POST", "/v1/credit/lines", { agent_id, term_days }, `open:${agent_id}`);
  }
  drawCredit(agent_id: string, amount_cspr: number): Promise<unknown> {
    return this.request("POST", `/v1/credit/lines/${encodeURIComponent(agent_id)}/draw`, { amount_cspr });
  }
  repayCredit(agent_id: string, amount_cspr: number): Promise<unknown> {
    return this.request("POST", `/v1/credit/lines/${encodeURIComponent(agent_id)}/repay`, { amount_cspr });
  }
  reviewCreditLine(agent_id: string): Promise<unknown> {
    return this.request("POST", `/v1/credit/lines/${encodeURIComponent(agent_id)}/review`);
  }
  reviewAllCreditLines(): Promise<unknown> {
    return this.request("POST", "/v1/credit/review-all");
  }

  // -- bureau analytics: discovery, trust, portfolio, benchmark, history --
  discover(query: { service_type?: string; min_reputation?: number; min_score?: number; limit?: number } = {}): Promise<unknown> {
    const qs = new URLSearchParams();
    if (query.service_type) qs.set("service_type", query.service_type);
    if (query.min_reputation !== undefined) qs.set("min_reputation", String(query.min_reputation));
    if (query.min_score !== undefined) qs.set("min_score", String(query.min_score));
    if (query.limit !== undefined) qs.set("limit", String(query.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request("GET", `/v1/discovery${suffix}`);
  }
  attestationGraph(): Promise<unknown> {
    return this.request("GET", "/v1/attestations/graph");
  }
  attest(from: string, to: string, note = ""): Promise<unknown> {
    return this.request("POST", "/v1/attestations", { from, to, note });
  }
  portfolio(): Promise<unknown> {
    return this.request("GET", "/v1/credit/portfolio");
  }
  riskAlerts(): Promise<unknown> {
    return this.request("GET", "/v1/risk/alerts");
  }
  yieldProjection(): Promise<unknown> {
    return this.request("GET", "/v1/credit/yield-projection");
  }
  fleetOverview(agent_ids: string[]): Promise<unknown> {
    return this.request("POST", "/v1/operators/fleet-overview", { agent_ids });
  }
  benchmark(agent_id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/benchmark`);
  }
  compareAgents(a: string, b: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  }
  creditHistory(agent_id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/history`);
  }
  onboardingReadiness(agent_id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/readiness`);
  }
  scoreTrend(agent_id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/score-trend`);
  }
  agentMultichain(agent_id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/multichain`);
  }
  agentHealth(agent_id: string): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/health`);
  }
  similarAgents(agent_id: string, limit?: number): Promise<unknown> {
    const suffix = limit !== undefined ? `?limit=${limit}` : "";
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/similar${suffix}`);
  }
  creditCost(agent_id: string, draw_cspr: number): Promise<unknown> {
    return this.request("GET", `/v1/agents/${encodeURIComponent(agent_id)}/credit-cost?draw_cspr=${draw_cspr}`);
  }
  simulateCredit(input: { monthly_revenue_cspr: number; reputation?: number; stake_cspr?: number; accuracy?: number; dispute_rate?: number; jobs_completed?: number; service_type?: string }): Promise<unknown> {
    return this.request("POST", "/v1/credit/simulate", input);
  }
  creditOffers(agent_id?: string): Promise<unknown[]> {
    const suffix = agent_id ? `?agent_id=${encodeURIComponent(agent_id)}` : "";
    return this.request("GET", `/v1/credit/offers${suffix}`);
  }
  issueCreditOffer(agent_id: string): Promise<unknown> {
    return this.request("POST", "/v1/credit/offers", { agent_id }, `offer:${agent_id}`);
  }
  acceptCreditOffer(offer_id: string): Promise<unknown> {
    return this.request("POST", `/v1/credit/offers/${encodeURIComponent(offer_id)}/accept`);
  }
  declineCreditOffer(offer_id: string): Promise<unknown> {
    return this.request("POST", `/v1/credit/offers/${encodeURIComponent(offer_id)}/decline`);
  }

  // -- markets / analytics ------------------------------------------------
  marketplace(): Promise<MarketListing[]> {
    return this.request("GET", "/v1/marketplace");
  }
  economics(): Promise<unknown> {
    return this.request("GET", "/v1/economics");
  }
  analytics(): Promise<unknown> {
    return this.request("GET", "/v1/analytics");
  }
  categoryAnalytics(): Promise<unknown> {
    return this.request("GET", "/v1/analytics/categories");
  }
  reputationMovers(limit?: number): Promise<unknown> {
    const suffix = limit !== undefined ? `?limit=${limit}` : "";
    return this.request("GET", `/v1/analytics/reputation-movers${suffix}`);
  }
  disputeStats(): Promise<unknown> {
    return this.request("GET", "/v1/analytics/disputes");
  }
  x402Stats(): Promise<unknown> {
    return this.request("GET", "/v1/analytics/x402");
  }
  notifications(): Promise<unknown[]> {
    return this.request("GET", "/v1/notifications");
  }
  search(q: string): Promise<unknown[]> {
    return this.request("GET", `/v1/search?q=${encodeURIComponent(q)}`);
  }

  // -- realfi -------------------------------------------------------------
  realfiState(): Promise<unknown> {
    return this.request("GET", "/v1/realfi");
  }
  verifyOperator(operator_id: string, jurisdiction: string, verification_reference: string): Promise<unknown> {
    return this.request("POST", "/v1/realfi/operators", {
      operator_id, jurisdiction, verification_level: "business_verified", verification_reference,
    });
  }
  recordFiatReceipt(input: { seller_agent: string; operator_id: string; amount: string; currency?: string; provider_event_id: string; provider_receipt_id: string }): Promise<unknown> {
    return this.request("POST", "/v1/realfi/fiat-receipts", input);
  }

  // -- disputes -----------------------------------------------------------
  openDispute(respondent_agent: string, dispute_type?: string, note?: string): Promise<unknown> {
    return this.request("POST", "/v1/disputes", { respondent_agent, dispute_type, note });
  }

  // -- admin --------------------------------------------------------------
  listApiKeys(): Promise<Array<{ id: string; name: string; scopes: Scope[] }>> {
    return this.request("GET", "/v1/admin/api-keys");
  }
  createApiKey(name: string, scopes: Scope[]): Promise<IssuedApiKey> {
    return this.request("POST", "/v1/admin/api-keys", { name, scopes });
  }
  webhookDeliveries(subscription_id?: string): Promise<unknown[]> {
    const suffix = subscription_id ? `?subscription_id=${encodeURIComponent(subscription_id)}` : "";
    return this.request("GET", `/v1/webhooks/deliveries${suffix}`);
  }
  listWebhooks(): Promise<Array<{ id: string; url: string; events: string[] }>> {
    return this.request("GET", "/v1/webhooks");
  }
  subscribeWebhook(url: string, events: string[] = ["*"]): Promise<WebhookSubscription> {
    return this.request("POST", "/v1/webhooks", { url, events });
  }

  // -- graphql ------------------------------------------------------------
  async graphql<T = unknown>(query: string, variables?: Record<string, unknown>): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) throw new Cred402Error("graphql_error", body.errors.map((e) => e.message).join("; "), res.status);
    return body.data as T;
  }
}
