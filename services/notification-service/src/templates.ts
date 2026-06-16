import type { Notification, RenderedMessage, Severity } from "./types.js";

/**
 * Event classes used for routing filters and template selection.
 *
 * The upstream feed (lib/services/notifications.ts) does not always carry the
 * raw EventName, so notifications are classified by their `event_name` when
 * present, otherwise by matching the human title. Subscriptions filter on these
 * stable class names rather than raw event names.
 */
export type EventClass =
  | "credit"
  | "dispute"
  | "slashing"
  | "protocol"
  | "operator"
  | "fiat"
  | "agent"
  | "policy"
  | "other";

/** Severity-driven color palette (hex), shared by Slack/Discord/console. */
const SEVERITY_COLOR: Readonly<Record<Severity, string>> = {
  info: "#3b82f6", // blue
  success: "#2eb67d", // green
  warning: "#e8a33d", // amber
  critical: "#e01e5a", // red
};

/** Fallback emoji per severity when no event-specific glyph applies. */
const SEVERITY_EMOJI: Readonly<Record<Severity, string>> = {
  info: "ℹ️",
  success: "✅",
  warning: "⚠️",
  critical: "🚨",
};

interface TemplateSpec {
  readonly eventClass: EventClass;
  readonly emoji: string;
  /** Optional color override; defaults to the severity color. */
  readonly color?: string;
  /** Optional body rewrite; defaults to the notification detail. */
  readonly body?: (n: Notification) => string;
}

/**
 * Templates keyed by raw EventName. Covers the full set required by the
 * notification-service spec; the resolver also matches on title when the raw
 * event name is unavailable.
 */
const TEMPLATES: Readonly<Record<string, TemplateSpec>> = {
  // ---- credit lifecycle ----
  CreditLineOpened: { eventClass: "credit", emoji: "🟢", body: (n) => `Credit approved — ${n.detail}` },
  CreditDrawn: { eventClass: "credit", emoji: "💸", body: (n) => `Funds drawn — ${n.detail}` },
  CreditRepaid: { eventClass: "credit", emoji: "🟩", body: (n) => `Repayment received — ${n.detail}` },
  CreditFrozen: { eventClass: "credit", emoji: "🧊", body: (n) => `Credit line frozen — ${n.detail}` },
  CreditDefaulted: { eventClass: "credit", emoji: "❌", body: (n) => `Default — ${n.detail}` },
  CreditScoreSet: { eventClass: "credit", emoji: "📊", body: (n) => `Credit score set — ${n.detail}` },

  // ---- disputes ----
  DisputeOpened: { eventClass: "dispute", emoji: "⚖️", body: (n) => `Dispute opened — ${n.detail}` },
  DisputeVerdictIssued: { eventClass: "dispute", emoji: "🧑‍⚖️", body: (n) => `Verdict — ${n.detail}` },
  DisputeClosed: { eventClass: "dispute", emoji: "📕", body: (n) => `Dispute closed — ${n.detail}` },

  // ---- slashing ----
  StakeSlashed: { eventClass: "slashing", emoji: "🔪", body: (n) => `Stake slashed — ${n.detail}` },
  StakeSlashedToVault: { eventClass: "slashing", emoji: "🔪", body: (n) => `Stake slashed to vault — ${n.detail}` },
  SlashDistributed: { eventClass: "slashing", emoji: "💰", body: (n) => `Slash distributed — ${n.detail}` },

  // ---- protocol / governance ----
  ProtocolPaused: { eventClass: "protocol", emoji: "⛔", body: (n) => `Protocol paused — ${n.detail}` },
  ProtocolUnpaused: { eventClass: "protocol", emoji: "▶️", body: (n) => `Protocol resumed — ${n.detail}` },
  GovernanceParameterUpdated: { eventClass: "protocol", emoji: "🗳️", body: (n) => `Governance update — ${n.detail}` },
  PolicyUpgraded: { eventClass: "policy", emoji: "🧭", body: (n) => `Risk policy upgraded — ${n.detail}` },

  // ---- operators / realfi ----
  OperatorVerified: { eventClass: "operator", emoji: "🏅", body: (n) => `Operator verified — ${n.detail}` },
  OperatorVerificationRevoked: { eventClass: "operator", emoji: "🚫", body: (n) => `Operator verification revoked — ${n.detail}` },
  FiatReceiptRecorded: { eventClass: "fiat", emoji: "🧾", body: (n) => `Fiat receipt — ${n.detail}` },
  FiatReceiptFinalized: { eventClass: "fiat", emoji: "🧾", body: (n) => `Fiat receipt finalized — ${n.detail}` },
  FiatReceiptDisputed: { eventClass: "fiat", emoji: "🧾", body: (n) => `Fiat receipt disputed — ${n.detail}` },

  // ---- agents ----
  AgentRegistered: { eventClass: "agent", emoji: "🤖", body: (n) => `Agent registered — ${n.detail}` },
  Staked: { eventClass: "agent", emoji: "🔐", body: (n) => `Stake posted — ${n.detail}` },
  ReputationUpdated: { eventClass: "agent", emoji: "⭐", body: (n) => `Reputation updated — ${n.detail}` },
};

/**
 * Title-based fallbacks (matched case-insensitively, substring) for when the
 * raw event name is not present on the notification. Mirrors the titles emitted
 * by lib/services/notifications.ts.
 */
const TITLE_FALLBACKS: ReadonlyArray<{ readonly match: string; readonly key: string }> = [
  { match: "credit line approved", key: "CreditLineOpened" },
  { match: "credit drawn", key: "CreditDrawn" },
  { match: "credit repaid", key: "CreditRepaid" },
  { match: "credit line frozen", key: "CreditFrozen" },
  { match: "agent defaulted", key: "CreditDefaulted" },
  { match: "dispute opened", key: "DisputeOpened" },
  { match: "dispute verdict", key: "DisputeVerdictIssued" },
  { match: "stake slashed", key: "StakeSlashed" },
  { match: "protocol paused", key: "ProtocolPaused" },
  { match: "protocol resumed", key: "ProtocolUnpaused" },
  { match: "risk policy upgraded", key: "PolicyUpgraded" },
  { match: "fiat receipt", key: "FiatReceiptRecorded" },
  { match: "operator verified", key: "OperatorVerified" },
  { match: "agent registered", key: "AgentRegistered" },
];

/** Resolve the template spec for a notification, or undefined if none matches. */
function resolveSpec(n: Notification): TemplateSpec | undefined {
  if (n.event_name) {
    const direct = TEMPLATES[n.event_name];
    if (direct) {
      return direct;
    }
  }
  const title = n.title.toLowerCase();
  for (const fb of TITLE_FALLBACKS) {
    if (title.includes(fb.match)) {
      return TEMPLATES[fb.key];
    }
  }
  return undefined;
}

/** Classify a notification into an EventClass for routing filters. */
export function classify(n: Notification): EventClass {
  return resolveSpec(n)?.eventClass ?? "other";
}

/**
 * Render a notification into a channel-agnostic RenderedMessage. Always returns
 * a usable message: unknown event types degrade gracefully to a severity-styled
 * generic rendering rather than being dropped.
 */
export function render(n: Notification): RenderedMessage {
  const spec = resolveSpec(n);
  const color = spec?.color ?? SEVERITY_COLOR[n.severity];
  const emoji = spec?.emoji ?? SEVERITY_EMOJI[n.severity];
  const body = spec?.body ? spec.body(n) : n.detail || n.title;

  return {
    title: n.title,
    body,
    severity: n.severity,
    color,
    emoji,
    notificationId: n.id,
    seq: n.seq,
    ...(n.agent_id !== undefined ? { agentId: n.agent_id } : {}),
    timestamp: n.timestamp,
    fields: buildFields(n),
  };
}

function buildFields(n: Notification): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const fields: Array<{ label: string; value: string }> = [
    { label: "severity", value: n.severity },
    { label: "class", value: classify(n) },
  ];
  if (n.agent_id) {
    fields.push({ label: "agent", value: n.agent_id });
  }
  return fields;
}
