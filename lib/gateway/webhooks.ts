import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Outbound webhooks (p2 §7.1).
 *
 * External systems subscribe to protocol events (receipt finalized, credit
 * frozen, dispute opened…). Each delivery is HMAC-SHA256 signed over
 * `${timestamp}.${body}` so receivers can verify authenticity and reject
 * replays. Failed deliveries retry with exponential backoff up to a cap.
 */

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[]; // event names, or ["*"] for all
  secret: string;
  created_at: number;
  disabled_at?: number;
}

export interface DeliveryAttempt {
  subscription_id: string;
  event: string;
  status: "delivered" | "failed";
  http_status?: number;
  attempts: number;
  error?: string;
}

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

export class WebhookService {
  private readonly subs = new Map<string, WebhookSubscription>();

  constructor(
    private readonly maxRetries: number,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  subscribe(url: string, events: string[]): WebhookSubscription {
    if (!/^https?:\/\//.test(url)) throw new Error("webhook url must be http(s)");
    const sub: WebhookSubscription = {
      id: "wh_" + randomBytes(6).toString("hex"),
      url,
      events: events.length ? events : ["*"],
      secret: "whsec_" + randomBytes(24).toString("base64url"),
      created_at: this.now(),
    };
    this.subs.set(sub.id, sub);
    return sub;
  }

  unsubscribe(id: string): boolean {
    const s = this.subs.get(id);
    if (!s || s.disabled_at) return false;
    s.disabled_at = this.now();
    return true;
  }

  list(): Array<Omit<WebhookSubscription, "secret">> {
    return [...this.subs.values()].map(({ secret: _s, ...rest }) => rest);
  }

  private matches(sub: WebhookSubscription, event: string): boolean {
    return !sub.disabled_at && (sub.events.includes("*") || sub.events.includes(event));
  }

  /** Sign `${timestamp}.${body}` with the subscription secret. */
  static sign(secret: string, timestamp: number, body: string): string {
    return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  }

  /** Verify an inbound signature (for receivers / tests). */
  static verify(secret: string, header: string, body: string, now: number, toleranceMs = 5 * 60_000): boolean {
    const m = /t=(\d+),v1=([0-9a-f]+)/.exec(header);
    if (!m) return false;
    const ts = Number(m[1]);
    if (Math.abs(now - ts) > toleranceMs) return false;
    const expected = Buffer.from(WebhookService.sign(secret, ts, body));
    const got = Buffer.from(m[2]!);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }

  /** Deliver an event to all matching subscribers; retries with backoff. */
  async dispatch(event: string, payload: Record<string, unknown>): Promise<DeliveryAttempt[]> {
    const results: DeliveryAttempt[] = [];
    for (const sub of this.subs.values()) {
      if (!this.matches(sub, event)) continue;
      results.push(await this.deliverOne(sub, event, payload));
    }
    return results;
  }

  private async deliverOne(sub: WebhookSubscription, event: string, payload: Record<string, unknown>): Promise<DeliveryAttempt> {
    const body = JSON.stringify({ event, data: payload }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    let lastErr: string | undefined;
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      const ts = this.now();
      try {
        const res = await this.fetchFn(sub.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Cred402-Event": event,
            "X-Cred402-Signature": `t=${ts},v1=${WebhookService.sign(sub.secret, ts, body)}`,
          },
          body,
        });
        if (res.status >= 200 && res.status < 300) {
          return { subscription_id: sub.id, event, status: "delivered", http_status: res.status, attempts: attempt };
        }
        lastErr = `http ${res.status}`;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      if (attempt <= this.maxRetries) await this.sleep(Math.min(30_000, 2 ** (attempt - 1) * 250));
    }
    return { subscription_id: sub.id, event, status: "failed", attempts: this.maxRetries + 1, error: lastErr };
  }
}

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status };
};
