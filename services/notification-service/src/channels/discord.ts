import type { Channel } from "./channel.js";
import type { RenderedMessage, SendResult } from "../types.js";

/** Configuration for the Discord webhook channel. */
export interface DiscordConfig {
  /** Channel name; defaults to "discord". */
  readonly name?: string;
  /** Discord webhook URL (https://discord.com/api/webhooks/...). */
  readonly webhookUrl: string;
  /** Optional username override shown in Discord. */
  readonly username?: string;
  /** Per-request timeout in ms; defaults to 8000. */
  readonly timeoutMs?: number;
}

/**
 * Discord webhook channel.
 *
 * Emits a real Discord message: a short `content` line plus a rich `embed`
 * with a colored side stripe, the body as the description, and structured
 * fields. Discord webhooks respond `204 No Content` on success.
 */
export class DiscordChannel implements Channel {
  public readonly name: string;
  private readonly webhookUrl: string;
  private readonly username: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: DiscordConfig) {
    if (!config.webhookUrl) {
      throw new Error("DiscordChannel requires a webhookUrl");
    }
    this.name = config.name ?? "discord";
    this.webhookUrl = config.webhookUrl;
    this.username = config.username;
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    const payload = buildDiscordPayload(message, this.username);
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

interface DiscordEmbedField {
  readonly name: string;
  readonly value: string;
  readonly inline: boolean;
}

interface DiscordEmbed {
  readonly title: string;
  readonly description: string;
  readonly color: number;
  readonly timestamp: string;
  readonly fields: ReadonlyArray<DiscordEmbedField>;
  readonly footer: { readonly text: string };
}

interface DiscordPayload {
  readonly content: string;
  readonly username?: string;
  readonly embeds: ReadonlyArray<DiscordEmbed>;
}

/** Build a Discord webhook payload from a rendered message. */
export function buildDiscordPayload(message: RenderedMessage, username?: string): DiscordPayload {
  const fields: DiscordEmbedField[] = message.fields.map((f) => ({
    name: f.label,
    value: f.value || "—",
    inline: true,
  }));

  const embed: DiscordEmbed = {
    title: truncate(`${message.emoji} ${message.title}`, 256),
    description: truncate(message.body || "(no detail)", 4096),
    color: hexToInt(message.color),
    timestamp: new Date(message.timestamp).toISOString(),
    fields,
    footer: { text: `Cred402 · seq ${message.seq}` },
  };

  return {
    content: `${message.emoji} **${message.title}**`,
    ...(username !== undefined ? { username } : {}),
    embeds: [embed],
  };
}

/** Convert a "#rrggbb" string to the integer Discord expects. Falls back to grey. */
export function hexToInt(hex: string): number {
  const cleaned = hex.replace(/^#/, "");
  const parsed = Number.parseInt(cleaned, 16);
  return Number.isFinite(parsed) ? parsed & 0xffffff : 0x95a5a6;
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
