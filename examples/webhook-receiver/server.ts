import { createServer, type IncomingMessage } from "node:http";
import { verifyWebhookSignature } from "../../packages/ts-sdk/src/index.js";

/**
 * Cred402 webhook receiver — a real, runnable endpoint that ingests protocol
 * webhooks and verifies their HMAC signature with `@cred402/sdk`.
 *
 *   1. start it:        CRED402_WEBHOOK_SECRET=whsec_... npx tsx examples/webhook-receiver/server.ts
 *   2. subscribe it:    curl -XPOST localhost:4021/v1/webhooks -d '{"url":"http://localhost:4055/","events":["*"]}'
 *      (the response's `secret` is your CRED402_WEBHOOK_SECRET)
 *   3. trigger events:  curl -XPOST localhost:4021/api/demo/run
 *
 * Every delivery is verified; tampered or stale signatures are rejected with 401.
 */
const PORT = Number(process.env.WEBHOOK_RECEIVER_PORT ?? 4055);
const SECRET = process.env.CRED402_WEBHOOK_SECRET ?? "";

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const server = createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end();
    return;
  }
  const raw = await readRaw(req);
  const sig = (req.headers["x-cred402-signature"] as string) ?? "";
  const event = (req.headers["x-cred402-event"] as string) ?? "?";

  const verified = SECRET
    ? verifyWebhookSignature({ secret: SECRET, signatureHeader: sig, rawBody: raw })
    : false;

  if (SECRET && !verified) {
    console.warn(`✗ REJECTED ${event} — bad/stale signature`);
    res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: false, error: "invalid signature" }));
    return;
  }

  let payload: unknown = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    /* keep raw */
  }
  console.log(`✓ ${verified ? "VERIFIED" : "UNSIGNED"} ${event}`, JSON.stringify(payload));
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true }));
});

server.listen(PORT, () => {
  console.log(`Cred402 webhook receiver on http://localhost:${PORT}/ (${SECRET ? "verifying" : "no secret set — accepting unsigned"})`);
});
