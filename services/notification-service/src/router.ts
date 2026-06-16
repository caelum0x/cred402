import type { Channel } from "./channels/channel.js";
import type { Notification, RetryPolicy, Subscription } from "./types.js";
import { SEVERITY_ORDER } from "./types.js";
import { classify, render } from "./templates.js";

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 4000,
};

/** Per-delivery outcome returned by the router for observability. */
export interface DeliveryOutcome {
  readonly channel: string;
  readonly notificationId: string;
  readonly ok: boolean;
  readonly attempts: number;
  readonly detail?: string;
}

export interface RouterOptions {
  readonly retry?: Partial<RetryPolicy>;
  /** Max number of delivered notification ids retained for dedupe. */
  readonly dedupeWindow?: number;
  /** Sleep function (injectable for tests); defaults to real setTimeout. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Fan-out router with dedupe and per-channel retry/backoff.
 *
 * Channels are registered, then subscriptions bind a channel to a delivery
 * policy (min severity + optional event-class allow-list). For each incoming
 * notification the router:
 *   1. skips it if already delivered (dedupe by notification id),
 *   2. renders it once via the templates,
 *   3. sends to every matching channel with exponential backoff retries.
 *
 * The router is immutable in spirit: registration returns new internal arrays
 * rather than mutating shared inputs, and dedupe state is the only mutable
 * field (bounded by an insertion-ordered set).
 */
export class NotificationRouter {
  private readonly channels: Map<string, Channel> = new Map();
  private readonly subscriptions: Subscription[] = [];
  private readonly seen: Set<string> = new Set();
  private readonly retry: RetryPolicy;
  private readonly dedupeWindow: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RouterOptions = {}) {
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.dedupeWindow = options.dedupeWindow ?? 5000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  /** Register a channel. Throws if a channel with the same name exists. */
  registerChannel(channel: Channel): this {
    if (this.channels.has(channel.name)) {
      throw new Error(`channel already registered: ${channel.name}`);
    }
    this.channels.set(channel.name, channel);
    return this;
  }

  /** Add a subscription binding a registered channel to a delivery policy. */
  subscribe(subscription: Subscription): this {
    if (!this.channels.has(subscription.channel)) {
      throw new Error(`cannot subscribe unknown channel: ${subscription.channel}`);
    }
    this.subscriptions.push(subscription);
    return this;
  }

  /** Names of registered channels. */
  channelNames(): ReadonlyArray<string> {
    return [...this.channels.keys()];
  }

  /** Whether a notification id has already been delivered. */
  hasSeen(id: string): boolean {
    return this.seen.has(id);
  }

  /**
   * Dispatch a single notification to all matching channels.
   * Returns one outcome per channel attempted (empty if deduped or no match).
   */
  async dispatch(notification: Notification): Promise<ReadonlyArray<DeliveryOutcome>> {
    if (this.seen.has(notification.id)) {
      return [];
    }
    this.markSeen(notification.id);

    const eventClass = classify(notification);
    const targets = this.matchingChannels(notification.severity, eventClass);
    if (targets.length === 0) {
      return [];
    }

    const message = render(notification);
    const outcomes = await Promise.all(
      targets.map((channel) => this.deliverWithRetry(channel, message.notificationId, () => channel.send(message))),
    );
    return outcomes;
  }

  /** Dispatch a batch in ascending seq order; returns flattened outcomes. */
  async dispatchAll(notifications: ReadonlyArray<Notification>): Promise<ReadonlyArray<DeliveryOutcome>> {
    const ordered = [...notifications].sort((a, b) => a.seq - b.seq);
    const all: DeliveryOutcome[] = [];
    for (const n of ordered) {
      const outcomes = await this.dispatch(n);
      all.push(...outcomes);
    }
    return all;
  }

  private matchingChannels(severity: Notification["severity"], eventClass: string): Channel[] {
    const result: Channel[] = [];
    const claimed = new Set<string>();
    for (const sub of this.subscriptions) {
      if (claimed.has(sub.channel)) {
        continue;
      }
      if (SEVERITY_ORDER[severity] < SEVERITY_ORDER[sub.minSeverity]) {
        continue;
      }
      if (sub.eventTypes && !sub.eventTypes.includes(eventClass)) {
        continue;
      }
      const channel = this.channels.get(sub.channel);
      if (channel) {
        result.push(channel);
        claimed.add(sub.channel);
      }
    }
    return result;
  }

  private async deliverWithRetry(
    channel: Channel,
    notificationId: string,
    attempt: () => Promise<{ ok: boolean; detail?: string }>,
  ): Promise<DeliveryOutcome> {
    let lastDetail: string | undefined;
    for (let i = 1; i <= this.retry.maxAttempts; i += 1) {
      let result: { ok: boolean; detail?: string };
      try {
        result = await attempt();
      } catch (error: unknown) {
        result = { ok: false, detail: error instanceof Error ? error.message : "send threw" };
      }
      if (result.ok) {
        return {
          channel: channel.name,
          notificationId,
          ok: true,
          attempts: i,
          ...(result.detail !== undefined ? { detail: result.detail } : {}),
        };
      }
      lastDetail = result.detail;
      if (i < this.retry.maxAttempts) {
        await this.sleep(this.backoff(i));
      }
    }
    return {
      channel: channel.name,
      notificationId,
      ok: false,
      attempts: this.retry.maxAttempts,
      ...(lastDetail !== undefined ? { detail: lastDetail } : {}),
    };
  }

  private backoff(attempt: number): number {
    const exp = this.retry.baseDelayMs * 2 ** (attempt - 1);
    const capped = Math.min(exp, this.retry.maxDelayMs);
    // Full jitter to avoid thundering-herd retries across channels.
    return Math.floor(Math.random() * capped);
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    if (this.seen.size > this.dedupeWindow) {
      // Evict oldest insertion to keep the set bounded (Set preserves order).
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
