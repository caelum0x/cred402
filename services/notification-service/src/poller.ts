import type { NotificationRouter, DeliveryOutcome } from "./router.js";
import type { Notification, Severity } from "./types.js";

export interface PollerOptions {
  /** Base URL of the Cred402 API, e.g. http://localhost:4021. */
  readonly apiBaseUrl: string;
  /** Poll interval in ms; defaults to 2000. */
  readonly intervalMs?: number;
  /** Per-request timeout in ms; defaults to 8000. */
  readonly timeoutMs?: number;
  /** Optional callback fired after each batch of deliveries. */
  readonly onDelivered?: (outcomes: ReadonlyArray<DeliveryOutcome>) => void;
  /** Optional callback fired when a poll fails (non-fatal). */
  readonly onError?: (error: Error) => void;
}

/** Raw notification shape as served by GET /api/notifications. */
interface RawNotification {
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly severity?: unknown;
  readonly title?: unknown;
  readonly detail?: unknown;
  readonly agent_id?: unknown;
  readonly timestamp?: unknown;
  readonly event_name?: unknown;
}

const SEVERITIES: ReadonlyArray<Severity> = ["info", "success", "warning", "critical"];

/**
 * Polling source.
 *
 * Polls GET /api/notifications, validates each record at the boundary, keeps
 * only notifications with a seq greater than the highest already processed, and
 * feeds the new ones (ascending seq) into the router. The router's own dedupe
 * by id provides a second safety net. Tracking the last seq makes each poll
 * cheap and idempotent even though the endpoint returns the full recent feed.
 */
export class NotificationPoller {
  private readonly apiBaseUrl: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly onDelivered: ((outcomes: ReadonlyArray<DeliveryOutcome>) => void) | undefined;
  private readonly onError: ((error: Error) => void) | undefined;
  private lastSeq = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;

  constructor(
    private readonly router: NotificationRouter,
    options: PollerOptions,
  ) {
    if (!options.apiBaseUrl) {
      throw new Error("NotificationPoller requires apiBaseUrl");
    }
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.intervalMs = options.intervalMs ?? 2000;
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.onDelivered = options.onDelivered;
    this.onError = options.onError;
  }

  /** Highest seq processed so far (-1 before the first successful poll). */
  get cursor(): number {
    return this.lastSeq;
  }

  /**
   * Fetch the feed once, dispatch any new notifications, return the deliveries.
   * Does not throw on network/HTTP errors — surfaces them via onError and
   * returns an empty array so callers (and the loop) stay alive.
   */
  async pollOnce(): Promise<ReadonlyArray<DeliveryOutcome>> {
    let raw: ReadonlyArray<RawNotification>;
    try {
      raw = await this.fetchNotifications();
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error("poll failed");
      this.onError?.(err);
      return [];
    }

    const fresh = raw
      .map(parseNotification)
      .filter((n): n is Notification => n !== undefined && n.seq > this.lastSeq)
      .sort((a, b) => a.seq - b.seq);

    if (fresh.length > 0) {
      const maxSeq = fresh[fresh.length - 1]?.seq ?? this.lastSeq;
      this.lastSeq = Math.max(this.lastSeq, maxSeq);
    }

    const outcomes = await this.router.dispatchAll(fresh);
    if (outcomes.length > 0) {
      this.onDelivered?.(outcomes);
    }
    return outcomes;
  }

  /** Start the polling loop. Resolves immediately; runs until stop(). */
  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) {
        return;
      }
      await this.pollOnce();
      if (this.running) {
        this.timer = setTimeout(() => void tick(), this.intervalMs);
      }
    };
    void tick();
  }

  /** Stop the polling loop. */
  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private async fetchNotifications(): Promise<ReadonlyArray<RawNotification>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/notifications`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`GET /api/notifications -> HTTP ${res.status} ${res.statusText}`);
      }
      const parsed: unknown = await res.json();
      if (!Array.isArray(parsed)) {
        throw new Error("GET /api/notifications did not return an array");
      }
      return parsed as ReadonlyArray<RawNotification>;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Validate and normalize a raw record at the trust boundary. */
function parseNotification(raw: RawNotification): Notification | undefined {
  const id = typeof raw.id === "string" ? raw.id : undefined;
  const seq = typeof raw.seq === "number" && Number.isFinite(raw.seq) ? raw.seq : undefined;
  const severity = isSeverity(raw.severity) ? raw.severity : undefined;
  const title = typeof raw.title === "string" ? raw.title : undefined;
  if (id === undefined || seq === undefined || severity === undefined || title === undefined) {
    return undefined;
  }
  const detail = typeof raw.detail === "string" ? raw.detail : "";
  const timestamp = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp) ? raw.timestamp : Date.now();
  const agentId = typeof raw.agent_id === "string" && raw.agent_id.length > 0 ? raw.agent_id : undefined;
  const eventName = typeof raw.event_name === "string" && raw.event_name.length > 0 ? raw.event_name : undefined;

  return {
    id,
    seq,
    severity,
    title,
    detail,
    timestamp,
    ...(agentId !== undefined ? { agent_id: agentId } : {}),
    ...(eventName !== undefined ? { event_name: eventName } : {}),
  };
}

function isSeverity(value: unknown): value is Severity {
  return typeof value === "string" && (SEVERITIES as ReadonlyArray<string>).includes(value);
}
