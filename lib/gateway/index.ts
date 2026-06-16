import { loadConfig, type GatewayConfig } from "./config.js";
import { createLogger, type Logger } from "./logger.js";
import { ApiKeyStore, type ApiKeyRecord, type Scope } from "./api_keys.js";
import { RateLimiter } from "./rate_limit.js";
import { IdempotencyStore } from "./idempotency.js";
import { WebhookService } from "./webhooks.js";
import { ForbiddenError, RateLimitError, UnauthorizedError } from "./errors.js";
import { randomBytes, createHash } from "node:crypto";

export * from "./config.js";
export * from "./logger.js";
export * from "./errors.js";
export * from "./validation.js";
export * from "./api_keys.js";
export * from "./rate_limit.js";
export * from "./idempotency.js";
export * from "./webhooks.js";
export * from "./persistence.js";

export interface AuthContext {
  key?: ApiKeyRecord;
  identity: string; // api key id or client ip — the rate-limit + log subject
}

/**
 * Gateway — assembles production middleware (config, logging, API keys, rate
 * limiting, idempotency, webhooks) from validated configuration. One instance is
 * shared by the versioned `/v1` API.
 */
export class Gateway {
  readonly config: GatewayConfig;
  readonly log: Logger;
  readonly apiKeys: ApiKeyStore;
  readonly rateLimiter: RateLimiter;
  readonly idempotency: IdempotencyStore;
  readonly webhooks: WebhookService;
  /** The bootstrap admin key minted from config, returned once at startup. */
  readonly bootstrapAdminKey?: string;

  constructor(config: GatewayConfig = loadConfig()) {
    this.config = config;
    this.log = createLogger(config.logLevel, { service: "cred402-gateway", env: config.env });
    this.apiKeys = new ApiKeyStore();
    this.rateLimiter = new RateLimiter(config.rateLimit.maxRequests, config.rateLimit.windowMs);
    this.idempotency = new IdempotencyStore();
    this.webhooks = new WebhookService(config.webhooks.maxRetries);
    if (config.authRequired && config.adminApiKey) {
      // Register the operator-provided admin key (store its hash, not the value).
      const issued = this.apiKeys.issue("bootstrap-admin", ["admin"]);
      this.bootstrapAdminKey = issued.secret;
    }
  }

  private readonly httpCounters = new Map<string, number>();

  /** Count a handled request by coarse route + status (for /metrics). */
  recordHttp(route: string, status: number): void {
    const k = `${route}|${status}`;
    this.httpCounters.set(k, (this.httpCounters.get(k) ?? 0) + 1);
  }

  /** Prometheus lines for HTTP request counts (appended to /metrics). */
  httpMetrics(): string {
    const lines = ["# HELP cred402_http_requests_total v1 requests by route+status", "# TYPE cred402_http_requests_total counter"];
    for (const [k, v] of [...this.httpCounters.entries()].sort()) {
      const [route, status] = k.split("|");
      lines.push(`cred402_http_requests_total{route="${route}",status="${status}"} ${v}`);
    }
    return lines.join("\n");
  }

  newRequestId(): string {
    return "req_" + randomBytes(8).toString("hex");
  }

  fingerprint(body: unknown): string {
    return createHash("sha256").update(JSON.stringify(body ?? {})).digest("hex");
  }

  /**
   * Resolve the auth context for a request. When auth is disabled (dev), the
   * client IP is the rate-limit identity; otherwise a valid scoped key is required.
   */
  authenticate(apiKeyHeader: string | undefined, clientIp: string, required: Scope): AuthContext {
    if (!this.config.authRequired) {
      return { identity: `ip:${clientIp}` };
    }
    const key = this.apiKeys.verify(apiKeyHeader);
    if (!key) throw new UnauthorizedError();
    if (!this.apiKeys.hasScope(key, required)) throw new ForbiddenError(`requires '${required}' scope`);
    return { key, identity: `key:${key.id}` };
  }

  enforceRateLimit(identity: string): { remaining: number; limit: number } {
    const r = this.rateLimiter.check(identity);
    if (!r.allowed) throw new RateLimitError(r.retryAfterMs);
    return { remaining: r.remaining, limit: this.config.rateLimit.maxRequests };
  }
}
