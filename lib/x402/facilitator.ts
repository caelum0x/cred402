/**
 * Real x402 facilitator client (p9) — speaks the x402 V2 protocol to the
 * `make-software/casper-x402` facilitator (Apache-2.0, the canonical Casper x402
 * facilitator from the Casper AI Toolkit).
 *
 * Cred402's built-in `verifyPayment` (ed25519 over a domain-separated
 * authorization) remains the default and keeps the demo dependency-free. When
 * `CRED402_X402_FACILITATOR_URL` is set, the gateway can additionally verify and
 * settle CEP-18 `transfer_with_authorization` payments against the real
 * facilitator — the production rail where the facilitator pays gas and submits
 * the settlement deploy.
 *
 * Run the facilitator locally (from the casper-x402 repo):
 *   docker build -f infra/docker/build-facilitator.Dockerfile -t casper-x402 .
 *   docker run -p 4022:4022 casper-x402         # GET /health -> {"status":"ok"}
 *
 * Contract: docs/api-reference.md in make-software/casper-x402.
 */

/** x402 V2 "exact" Casper authorization (transfer_with_authorization fields). */
export interface ExactCasperAuthorization {
  from: string; // "00" + 64 hex (account hash)
  to: string; // "00" + 64 hex
  value: string; // base units (motes/CEP-18)
  validAfter: string; // unix seconds
  validBefore: string; // unix seconds
  nonce: string; // 64 hex (32 bytes)
}

export interface ExactCasperPayload {
  x402Version: 2;
  scheme: "exact";
  network: string; // e.g. "casper:casper-net-1"
  payload: {
    signature: string; // 130 hex (65 bytes)
    publicKey: string; // algo-prefixed hex
    authorization: ExactCasperAuthorization;
  };
}

export interface PaymentRequirements {
  scheme: "exact";
  network: string;
  payTo: string; // "00" + 64 hex
  amount: string;
  asset: string; // 64 hex CEP-18 package hash
  extra: { name: string; version: string; decimals: string };
  maxTimeoutSeconds: number;
}

export interface VerifyResponse {
  isValid: boolean;
  payer?: string;
  invalidReason?: string;
  invalidMessage?: string;
}

export interface SettleResponse {
  success: boolean;
  transaction: string; // Casper deploy hash on success
  network: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
}

export interface SupportedKind {
  x402Version: number;
  scheme: string;
  network: string;
  extra?: Record<string, unknown>;
}

export interface FacilitatorClientOptions {
  baseUrl: string; // e.g. http://localhost:4022
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export class X402FacilitatorError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "X402FacilitatorError";
  }
}

/** Typed client for the casper-x402 facilitator's standard x402 V2 endpoints. */
export class CasperX402FacilitatorClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: FacilitatorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** `GET /health` → liveness. */
  async health(): Promise<boolean> {
    try {
      const r = await this.get<{ status?: string }>("/health");
      return r.status === "ok";
    } catch {
      return false;
    }
  }

  /** `GET /supported` → (scheme, network) pairs this facilitator settles. */
  async supported(): Promise<SupportedKind[]> {
    const r = await this.get<{ kinds: SupportedKind[] }>("/supported");
    return r.kinds ?? [];
  }

  /** `POST /verify` → validate a payment without touching chain state. */
  async verify(paymentPayload: ExactCasperPayload, paymentRequirements: PaymentRequirements): Promise<VerifyResponse> {
    return this.post<VerifyResponse>("/verify", { paymentPayload, paymentRequirements });
  }

  /** `POST /settle` → verify, build, sign, submit the settlement deploy. */
  async settle(paymentPayload: ExactCasperPayload, paymentRequirements: PaymentRequirements): Promise<SettleResponse> {
    return this.post<SettleResponse>("/settle", { paymentPayload, paymentRequirements });
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) throw new X402FacilitatorError(`facilitator ${path} -> HTTP ${res.status}`, res.status);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof X402FacilitatorError) throw err;
      if ((err as Error).name === "AbortError") throw new X402FacilitatorError(`facilitator timeout after ${this.timeoutMs}ms`);
      throw new X402FacilitatorError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build a client from CRED402_X402_FACILITATOR_URL, or null when unconfigured. */
export function facilitatorFromEnv(env: NodeJS.ProcessEnv = process.env): CasperX402FacilitatorClient | null {
  const url = env.CRED402_X402_FACILITATOR_URL;
  return url ? new CasperX402FacilitatorClient({ baseUrl: url }) : null;
}
