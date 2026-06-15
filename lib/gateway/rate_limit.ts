/**
 * Token-bucket rate limiter (p2 §7.1, security.md — rate limit all endpoints).
 *
 * Each identity (API key id or client IP) gets a bucket that refills at a steady
 * rate up to a burst capacity. Smoother than fixed windows and cheap: O(1) per
 * request, lazy refill, no background timers.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {
    // Refill a full bucket over one window.
    this.refillPerMs = capacity / windowMs;
  }

  check(identity: string, cost = 1): RateLimitResult {
    const t = this.now();
    const bucket = this.buckets.get(identity) ?? { tokens: this.capacity, lastRefill: t };
    // Lazy refill since last seen.
    const elapsed = t - bucket.lastRefill;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.lastRefill = t;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(identity, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    this.buckets.set(identity, bucket);
    const deficit = cost - bucket.tokens;
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(deficit / this.refillPerMs) };
  }

  /** Drop stale buckets to bound memory (call periodically). */
  evictIdle(maxIdleMs: number): void {
    const t = this.now();
    for (const [id, b] of this.buckets) {
      if (t - b.lastRefill > maxIdleMs) this.buckets.delete(id);
    }
  }
}
