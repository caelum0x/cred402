/**
 * Frontend runtime config.
 *
 * API_BASE lets the deployed console talk to the API directly (cross-origin) for
 * rock-solid Server-Sent Events. Vercel's edge can buffer/timeout proxied SSE, so
 * the live event streams connect straight to the API (which sets permissive CORS),
 * while plain REST keeps using the same-origin Vercel rewrites.
 *
 * Set VITE_API_BASE=https://cred402.onrender.com in the Vercel project env.
 * Empty in local dev → same-origin relative URLs (the local API / Vite proxy).
 */
export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

/** Build an absolute URL for an SSE/stream endpoint, honoring API_BASE. */
export function streamUrl(path: string): string {
  return `${API_BASE}${path}`;
}
