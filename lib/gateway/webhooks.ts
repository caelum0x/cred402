import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NotFoundError } from "./errors.js";

/**
 * Outbound webhooks (p2 §7.1).
 *
 * External systems subscribe to protocol events (receipt finalized, credit
 * frozen, dispute opened…). Each delivery is HMAC-SHA256 signed over
 * `${timestamp}.${body}` so receivers can verify authenticity and reject
 * replays. Failed deliveries retry with exponential backoff up to a cap.
 * Every delivery (success or exhausted-retry failure) is logged with its
 * original payload so a failed delivery can be manually replayed later —
 * {@link WebhookService.redeliver} — from the Developer console's webhook
 * delivery dashboard without the sender having to re-trigger the event.
 */

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[]; // event names, or ["*"] for all
  /** If set, only deliver events whose payload.agent_id matches. */
  agent_filter?: string;
  secret: string;
  created_at: number;
  disabled_at?: number;
}

export interface DeliveryAttempt {
  id: string;
  subscription_id: string;
  event: string;
  status: "delivered" | "failed";
  http_status?: number;
  attempts: number;
  error?: string;
  /** Set on deliveries created by {@link WebhookService.redeliver}. */
  replay_of?: string;
}

/** Internal ring-buffer record — keeps the original payload so a failed delivery can be replayed later. */
type StoredDelivery = DeliveryAttempt & { at: number; payload: Record<string, unknown> };

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number }>;

export class WebhookService {
  private readonly subs = new Map<string, WebhookSubscription>();
  /** Recent delivery attempts (ring buffer) for integrator debugging + manual replay. */
  private readonly deliveryLog: StoredDelivery[] = [];
  private static readonly MAX_DELIVERY_LOG = 200;

  constructor(
    private readonly maxRetries: number,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  subscribe(url: string, events: string[], agentFilter?: string): WebhookSubscription {
    if (!/^https?:\/\//.test(url)) throw new Error("webhook url must be http(s)");
    const sub: WebhookSubscription = {
      id: "wh_" + randomBytes(6).toString("hex"),
      url,
      events: events.length ? events : ["*"],
      agent_filter: agentFilter,
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

  /** Re-enable a previously disabled subscription. Returns false if it was already active or doesn't exist. */
  enable(id: string): boolean {
    const s = this.subs.get(id);
    if (!s || !s.disabled_at) return false;
    s.disabled_at = undefined;
    return true;
  }

  list(): Array<Omit<WebhookSubscription, "secret">> {
    return [...this.subs.values()].map(({ secret: _s, ...rest }) => rest);
  }

  private matches(sub: WebhookSubscription, event: string, payload: Record<string, unknown>): boolean {
    if (sub.disabled_at) return false;
    if (!sub.events.includes("*") && !sub.events.includes(event)) return false;
    if (sub.agent_filter && payload.agent_id !== sub.agent_filter) return false;
    return true;
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
      if (!this.matches(sub, event, payload)) continue;
      const attempt = await this.deliverOne(sub, event, payload);
      results.push(attempt);
      this.log(attempt, payload);
    }
    return results;
  }

  /** Recent delivery attempts, newest first (payload omitted — fetch it via {@link redeliver} instead). Filter by subscription id. */
  deliveries(subscriptionId?: string): Array<DeliveryAttempt & { at: number }> {
    const log = subscriptionId ? this.deliveryLog.filter((d) => d.subscription_id === subscriptionId) : this.deliveryLog;
    return [...log].reverse().map(({ payload: _p, ...rest }) => rest);
  }

  /**
   * Manually re-send a past delivery (success or failure) by its log id, using
   * the exact payload originally dispatched. Used by the Developer console's
   * webhook delivery dashboard to replay a failed delivery after an
   * integrator fixes their receiving endpoint — without needing the original
   * protocol event to fire again. Throws 404 if the delivery or its
   * subscription no longer exists (e.g. the subscription was deleted).
   */
  async redeliver(deliveryId: string): Promise<DeliveryAttempt & { at: number }> {
    const original = this.deliveryLog.find((d) => d.id === deliveryId);
    if (!original) throw new NotFoundError(`no delivery found for id ${deliveryId}`);
    const sub = this.subs.get(original.subscription_id);
    if (!sub) throw new NotFoundError(`subscription ${original.subscription_id} no longer exists`);
    const attempt = await this.deliverOne(sub, original.event, original.payload);
    const replay = { ...attempt, replay_of: deliveryId };
    this.log(replay, original.payload);
    const { payload: _p, ...rest } = this.deliveryLog[this.deliveryLog.length - 1]!;
    return rest;
  }

  /** Append a delivery result (with its payload) to the bounded ring buffer. */
  private log(attempt: DeliveryAttempt, payload: Record<string, unknown>): void {
    this.deliveryLog.push({ ...attempt, at: this.now(), payload });
    if (this.deliveryLog.length > WebhookService.MAX_DELIVERY_LOG) this.deliveryLog.shift();
  }

  private async deliverOne(sub: WebhookSubscription, event: string, payload: Record<string, unknown>): Promise<DeliveryAttempt> {
    const id = "dlv_" + randomBytes(6).toString("hex");
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
          return { id, subscription_id: sub.id, event, status: "delivered", http_status: res.status, attempts: attempt };
        }
        lastErr = `http ${res.status}`;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      if (attempt <= this.maxRetries) await this.sleep(Math.min(30_000, 2 ** (attempt - 1) * 250));
    }
    return { id, subscription_id: sub.id, event, status: "failed", attempts: this.maxRetries + 1, error: lastErr };
  }
}

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status };
};
