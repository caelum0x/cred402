import { type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, normalize } from "node:path";

/**
 * HTTP transport helpers for the hand-rolled Cred402 API server.
 *
 * These are the framework-agnostic request/response primitives (JSON encoding
 * with bigint support, CORS headers, body readers, and the SPA static file
 * server) extracted out of `server.ts` so the request router stays focused on
 * routing. No module-level mutable state lives here.
 */

const FRONTEND_DIR = resolve(process.cwd(), "frontend", "dist");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Payment, PAYMENT-SIGNATURE",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    ...headers,
  });
  res.end(payload);
}

export function sendInstructions(res: ServerResponse, instructions: { status: number; headers: Record<string, string>; body?: unknown }): void {
  const body = typeof instructions.body === "string"
    ? instructions.body
    : JSON.stringify(instructions.body ?? {});
  res.writeHead(instructions.status, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
    ...instructions.headers,
  });
  res.end(body);
}

export async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

/** Raw request body — required for Stripe webhook HMAC signature verification. */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function serveStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  try {
    let rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = normalize(resolve(FRONTEND_DIR, "." + rel));
    if (!filePath.startsWith(FRONTEND_DIR)) return false; // path traversal guard
    const s = await stat(filePath).catch(() => null);
    const target = s?.isFile() ? filePath : resolve(FRONTEND_DIR, "index.html"); // SPA fallback
    const data = await readFile(target);
    res.writeHead(200, { "Content-Type": MIME[extname(target)] ?? "application/octet-stream" });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}
