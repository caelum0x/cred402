import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify an inbound Cred402 webhook signature (server-side receivers).
 *
 * Cred402 signs each delivery with `X-Cred402-Signature: t=<ts>,v1=<hmac>` over
 * `${t}.${rawBody}`. Verify with the subscription's signing secret and reject
 * stale timestamps to prevent replay.
 */
export function verifyWebhookSignature(opts: {
  secret: string;
  signatureHeader: string;
  rawBody: string;
  now?: number;
  toleranceMs?: number;
}): boolean {
  const now = opts.now ?? Date.now();
  const tolerance = opts.toleranceMs ?? 5 * 60_000;
  const m = /t=(\d+),v1=([0-9a-f]+)/.exec(opts.signatureHeader);
  if (!m) return false;
  const ts = Number(m[1]);
  if (Math.abs(now - ts) > tolerance) return false;
  const expected = createHmac("sha256", opts.secret).update(`${ts}.${opts.rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(m[2] ?? "");
  return a.length === b.length && timingSafeEqual(a, b);
}
