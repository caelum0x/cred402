/**
 * Core types for the Cred402 notification-service.
 *
 * The service consumes protocol notifications (the same shape served by the
 * Cred402 API at GET /api/notifications) and delivers them to external
 * channels (Slack, Discord, generic webhooks, console) after rendering them
 * through severity/event-aware templates and routing them through
 * subscription rules.
 *
 * These types are intentionally self-contained: they mirror the upstream
 * `Notification`/`Severity`/`EventName` shapes without import-coupling to the
 * ledger so this service can run as an independent process.
 */

/** Severity ladder, identical to lib/services/notifications.ts. */
export type Severity = "info" | "success" | "warning" | "critical";

/** Numeric ordering for severity so thresholds can be compared. */
export const SEVERITY_ORDER: Readonly<Record<Severity, number>> = {
  info: 0,
  success: 1,
  warning: 2,
  critical: 3,
};

/**
 * A single protocol notification as emitted by the Cred402 API.
 *
 * `event_name` is an optional enrichment: the upstream feed does not always
 * carry the raw EventName, so templates fall back to title matching when it is
 * absent. See `templates.ts` for how the event class is inferred.
 */
export interface Notification {
  readonly id: string;
  readonly seq: number;
  readonly severity: Severity;
  readonly title: string;
  readonly detail: string;
  readonly agent_id?: string;
  readonly timestamp: number;
  /** Optional raw protocol event name when the source can supply it. */
  readonly event_name?: string;
}

/**
 * A rendered message ready for a channel to deliver. Channels pick the fields
 * they support (Slack/Discord use color+emoji+blocks, console uses all of it,
 * a bare webhook forwards the structured payload).
 */
export interface RenderedMessage {
  /** Short headline, e.g. "Credit line approved". */
  readonly title: string;
  /** Human body text describing the event. */
  readonly body: string;
  /** Severity carried through for channel-side styling. */
  readonly severity: Severity;
  /** Hex color (e.g. "#2eb67d") chosen per severity/event for rich channels. */
  readonly color: string;
  /** A single emoji glyph used as a visual marker. */
  readonly emoji: string;
  /** The notification id, carried through for dedupe and tracing. */
  readonly notificationId: string;
  /** The source sequence number. */
  readonly seq: number;
  /** Optional agent the notification concerns. */
  readonly agentId?: string;
  /** Epoch-ms timestamp of the underlying event. */
  readonly timestamp: number;
  /** Structured key/value context surfaced in rich channels and webhooks. */
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

/** Result of attempting to deliver a single message to a single channel. */
export interface SendResult {
  readonly ok: boolean;
  readonly detail?: string;
}

/**
 * A subscription binds a channel to a delivery policy: only notifications at or
 * above `minSeverity` whose event class is allowed (when `eventTypes` is set)
 * are routed to the channel.
 */
export interface Subscription {
  /** Channel name this subscription targets (matches Channel.name). */
  readonly channel: string;
  /** Minimum severity that should reach the channel. */
  readonly minSeverity: Severity;
  /**
   * Optional allow-list of event classes (see EventClass in templates.ts).
   * When omitted, all event classes are allowed.
   */
  readonly eventTypes?: ReadonlyArray<string>;
}

/** Retry/backoff policy applied per channel send. */
export interface RetryPolicy {
  /** Total attempts including the first (>= 1). */
  readonly maxAttempts: number;
  /** Base backoff in ms; grows exponentially per attempt. */
  readonly baseDelayMs: number;
  /** Upper bound on a single backoff delay in ms. */
  readonly maxDelayMs: number;
}

/**
 * A routing rule is a subscription plus the resolved channel it targets; the
 * router builds these internally when wiring channels to subscriptions.
 */
export interface RoutingRule {
  readonly subscription: Subscription;
}
