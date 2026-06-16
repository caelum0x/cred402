import type { Channel } from "./channel.js";
import type { RenderedMessage, SendResult } from "../types.js";

/** Configuration for the Slack incoming-webhook channel. */
export interface SlackConfig {
  /** Channel name; defaults to "slack". */
  readonly name?: string;
  /** Slack incoming-webhook URL (https://hooks.slack.com/services/...). */
  readonly webhookUrl: string;
  /** Optional username override shown in Slack. */
  readonly username?: string;
  /** Per-request timeout in ms; defaults to 8000. */
  readonly timeoutMs?: number;
}

/**
 * Slack incoming-webhook channel.
 *
 * Emits a real Slack message: a `text` fallback plus Block Kit `blocks` with a
 * header, the body, and a context line of structured fields. Slack incoming
 * webhooks respond `200 ok` on success.
 */
export class SlackChannel implements Channel {
  public readonly name: string;
  private readonly webhookUrl: string;
  private readonly username: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: SlackConfig) {
    if (!config.webhookUrl) {
      throw new Error("SlackChannel requires a webhookUrl");
    }
    this.name = config.name ?? "slack";
    this.webhookUrl = config.webhookUrl;
    this.username = config.username;
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    const payload = buildSlackPayload(message, this.username);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await safeText(res);
        return { ok: false, detail: `HTTP ${res.status} ${res.statusText}${text ? `: ${text}` : ""}` };
      }
      return { ok: true, detail: `HTTP ${res.status}` };
    } catch (error: unknown) {
      return { ok: false, detail: describeError(error) };
    } finally {
      clearTimeout(timer);
    }
  }
}

interface SlackBlock {
  readonly type: string;
  readonly text?: { readonly type: string; readonly text: string };
  readonly elements?: ReadonlyArray<{ readonly type: string; readonly text: string }>;
}

interface SlackAttachment {
  readonly color: string;
  readonly blocks: ReadonlyArray<SlackBlock>;
}

interface SlackPayload {
  readonly text: string;
  readonly username?: string;
  readonly attachments: ReadonlyArray<SlackAttachment>;
}

/** Build a Slack incoming-webhook payload from a rendered message. */
export function buildSlackPayload(message: RenderedMessage, username?: string): SlackPayload {
  const headerText = `${message.emoji} ${message.title}`;
  const blocks: SlackBlock[] = [
    { type: "header", text: { type: "plain_text", text: truncate(headerText, 150) } },
    { type: "section", text: { type: "mrkdwn", text: message.body || "_(no detail)_" } },
  ];

  const contextItems = message.fields.map((f) => `*${f.label}:* ${f.value}`);
  contextItems.push(`*seq:* ${message.seq}`);
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: contextItems.join("  ·  ") }],
  });

  return {
    text: `${message.emoji} ${message.title} — ${message.body}`,
    ...(username !== undefined ? { username } : {}),
    // Color via attachment so the severity stripe shows on the left edge.
    attachments: [{ color: message.color, blocks }],
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "AbortError" ? "request timed out" : error.message;
  }
  return "unknown delivery error";
}
