/**
 * Typed HTTP client for the Cred402 API. Handles two response surfaces:
 *
 *  - Raw console routes (`/api/*`, `/verify/*`) that return bare JSON.
 *  - Production `/v1/*` routes wrapped in a `{ success, data, request_id }`
 *    envelope (errors as `{ success:false, error:{code,message} }`).
 *
 * Supports bearer/X-Api-Key auth, idempotency keys, and friendly errors.
 * Uses the global `fetch` available in Node 20+ — zero external deps.
 */

export interface ClientOptions {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

/** A Cred402 API error surfaced with the upstream code + request id when present. */
export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

interface V1Envelope<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
  readonly request_id?: string;
}

function isEnvelope(v: unknown): v is V1Envelope<unknown> {
  return typeof v === "object" && v !== null && "success" in v;
}

export class Cred402Client {
  constructor(private readonly opts: ClientOptions) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json", ...extra };
    if (this.opts.apiKey) h["Authorization"] = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  private url(path: string): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    return `${base}${path.startsWith("/") ? path : `/${path}`}`;
  }

  private async request(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    const extra: Record<string, string> = {};
    if (body !== undefined) extra["Content-Type"] = "application/json";
    if (idempotencyKey) extra["Idempotency-Key"] = idempotencyKey;

    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        headers: this.headers(extra),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiClientError(
        `cannot reach Cred402 API at ${this.opts.baseUrl} (${reason}). Is the server running? Try: npm start`,
        0,
      );
    }

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (!res.ok) throw new ApiClientError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
        return text;
      }
    }

    // v1 envelope handling
    if (isEnvelope(parsed)) {
      if (parsed.success) return parsed.data;
      const e = parsed.error;
      throw new ApiClientError(
        e?.message ?? `request failed (HTTP ${res.status})`,
        res.status,
        e?.code,
        parsed.request_id,
      );
    }

    // raw routes
    if (!res.ok) {
      const msg =
        typeof parsed === "object" && parsed !== null && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : `request failed (HTTP ${res.status})`;
      throw new ApiClientError(msg, res.status);
    }
    return parsed;
  }

  /** GET a raw or enveloped JSON route; returns the unwrapped data. */
  get<T = unknown>(path: string): Promise<T> {
    return this.request("GET", path) as Promise<T>;
  }

  /** POST a raw or enveloped JSON route; returns the unwrapped data. */
  post<T = unknown>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    return this.request("POST", path, body ?? {}, idempotencyKey) as Promise<T>;
  }

  /**
   * Perform a raw fetch (no parsing) — used for the x402 402 challenge where we
   * need the response headers, not the body envelope.
   */
  async raw(method: string, path: string): Promise<Response> {
    try {
      return await fetch(this.url(path), { method, headers: this.headers() });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new ApiClientError(`cannot reach Cred402 API at ${this.opts.baseUrl} (${reason})`, 0);
    }
  }
}

/** Generate a short idempotency key for write operations. */
export function idempotencyKey(prefix = "cli"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
