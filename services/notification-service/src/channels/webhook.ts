import { createHmac, timingSafeEqual } from "node:crypto";
import type { Channel } from "./channel.js";
import type { RenderedMessage, SendResult } from "../types.js";

/** Configuration for the generic HMAC-signed webhook channel. */
export interface WebhookConfig {
  /** Channel name; defaults to "webhook". */
  readonly name?: string;
  /** Destination URL (https recommended). */
  readonly url: string;
  /**
   * Shared secret used to sign the request body with HMAC-SHA256. When omitted
   * the channel still posts but without a signature header.
   */
  readonly secret?: string;
  /** Header carrying the hex signature; defaults to "x-cred402-signature". */
  readonly signatureHeader?: string;
  /** Header carrying the timestamp used in the signed payload. */
  readonly timestampHeader?: string;
  /** Per-request timeout in ms; defaults to 8000. */
  readonly timeoutMs?: number;
}

/**
 * Generic webhook channel.
 *
 * Posts a structured JSON envelope of the rendered message and signs it with
 * HMAC-SHA256 over `${timestamp}.${body}` so the receiver can verify
 * authenticity and reject replays. The signature scheme mirrors common
 * provider conventions (Stripe/Slack-style `t.body`).
 */
export class WebhookChannel implements Channel {
  public readonly name: string;
  private readonly url: string;
  private readonly secret: string | undefined;
  private readonly signatureHeader: string;
  private readonly timestampHeader: string;
  private readonly timeoutMs: number;

  constructor(config: WebhookConfig) {
    if (!config.url) {
      throw new Error("WebhookChannel requires a url");
    }
    this.name = config.name ?? "webhook";
    this.url = config.url;
    this.secret = config.secret;
    this.signatureHeader = config.signatureHeader ?? "x-cred402-signature";
    this.timestampHeader = config.timestampHeader ?? "x-cred402-timestamp";
    this.timeoutMs = config.timeoutMs ?? 8000;
  }

  async send(message: RenderedMessage): Promise<SendResult> {
    const timestamp = Date.now().toString();
    const body = JSON.stringify(buildEnvelope(message));

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "cred402-notification-service/1.0",
      [this.timestampHeader]: timestamp,
    };
    if (this.secret) {
      headers[this.signatureHeader] = sign(this.secret, timestamp, body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers,
        body,
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

/** Build the signed payload string the same way the channel does (for testing/receivers). */
export function signedPayload(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** Produce the hex HMAC-SHA256 signature for a body. */
export function sign(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(signedPayload(timestamp, body)).digest("hex");
}

/**
 * Verify a signature in constant time. Exposed so a receiving service can reuse
 * the exact scheme this channel emits.
 */
export function verifySignature(secret: string, timestamp: string, body: string, signature: string): boolean {
  const expected = sign(secret, timestamp, body);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

interface WebhookEnvelope {
  readonly type: "cred402.notification";
  readonly notificationId: string;
  readonly seq: number;
  readonly severity: string;
  readonly title: string;
  readonly body: string;
  readonly color: string;
  readonly emoji: string;
  readonly agentId?: string;
  readonly timestamp: number;
  readonly fields: ReadonlyArray<{ readonly label: string; readonly value: string }>;
}

function buildEnvelope(message: RenderedMessage): WebhookEnvelope {
  return {
    type: "cred402.notification",
    notificationId: message.notificationId,
    seq: message.seq,
    severity: message.severity,
    title: message.title,
    body: message.body,
    color: message.color,
    emoji: message.emoji,
    ...(message.agentId !== undefined ? { agentId: message.agentId } : {}),
    timestamp: message.timestamp,
    fields: message.fields,
  };
}

async function safeText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 200);
  } catch {
    return "";
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "request timed out";
    }
    return error.message;
  }
  return "unknown delivery error";
}
