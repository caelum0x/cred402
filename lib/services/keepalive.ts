/**
 * keepalive.ts — the server-side half of the cold-start fix (STRATEGY.md's
 * "single highest-leverage conversion fix").
 *
 * Render's free tier spins a service down after ~15 minutes with no inbound
 * HTTP request, and the wake-up on the next real request can take 30-60s — long
 * enough that a first-time visitor's x402 call times out before it ever sees a
 * 402. A process can't wake ITSELF up once asleep (the dyno isn't running code
 * at all), but it CAN stop itself from ever going idle in the first place: if
 * something pings the service's own PUBLIC url (round-tripping out through
 * Render's edge and back) more often than the idle window, the idle timer never
 * fires for organic traffic. That's exactly what this job does, registered as
 * an `AutonomousScheduler` job (lib/keeperhub/scheduler.ts) at a 10-minute
 * cadence — comfortably under Render's ~15-minute threshold.
 *
 * Deliberately NOT auto-started in every environment: a local `npm run dev` has
 * no public URL and nothing to protect from sleep, so `shouldAutoStart()` gates
 * this to the real Render environment (Render always injects `RENDER=true`) or
 * an operator-supplied CRED402_KEEPALIVE_URL.
 */

const DEFAULT_PUBLIC_URL = "https://cred402-1.onrender.com";

export interface KeepaliveResult {
  ok: boolean;
  url: string;
  status?: number;
  ms: number;
  error?: string;
}

/** The URL this instance should self-ping — explicit env var wins, else the known public Render URL. */
export function keepaliveUrl(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.CRED402_KEEPALIVE_URL ?? DEFAULT_PUBLIC_URL).replace(/\/$/, "");
  return `${base}/v1/health`;
}

/** Only self-ping where there's an actual public dyno to protect from idling. */
export function shouldAutoStart(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RENDER === "true" || Boolean(env.CRED402_KEEPALIVE_URL);
}

/** One ping. Never throws — a failed ping is just a `{ ok: false }` result for the scheduler log. */
export async function pingSelf(env: NodeJS.ProcessEnv = process.env): Promise<KeepaliveResult> {
  const url = keepaliveUrl(env);
  const started = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { ok: res.ok, url, status: res.status, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, url, ms: Date.now() - started, error: (err as Error).message };
  }
}
