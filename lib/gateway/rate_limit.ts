/**
 * Token-bucket rate limiter (p2 §7.1, security.md — rate limit all endpoints).
 *
 * Each identity (API key id, org id, or client IP) gets a bucket that refills
 * at a steady rate up to a burst capacity. Smoother than fixed windows and
 * cheap: O(1) per request, lazy refill, no background timers.
 *
 * `capacity` passed to the constructor is only the DEFAULT. Every call site
 * may override it per-identity (`capacityOverride` on {@link check}/{@link
 * peek}) so a single shared limiter instance can serve plan-tiered limits —
 * e.g. an org's bucket sized by its `plan` — without allocating one
 * `RateLimiter` per tier. The refill window (`windowMs`) is fixed at
 * construction and shared by every identity; only the burst size varies.
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

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private refill(identity: string, capacity: number): Bucket {
    const t = this.now();
    const bucket = this.buckets.get(identity) ?? { tokens: capacity, lastRefill: t };
    const elapsed = t - bucket.lastRefill;
    const refillPerMs = capacity / this.windowMs;
    // Lazy refill since last seen, capped at the (possibly overridden) capacity —
    // if a plan downgrade shrinks capacity below the bucket's current token
    // count, clamp down rather than leaving a stale over-full bucket.
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
    bucket.lastRefill = t;
    return bucket;
  }

  check(identity: string, cost = 1, capacityOverride?: number): RateLimitResult {
    const capacity = capacityOverride ?? this.capacity;
    const bucket = this.refill(identity, capacity);
    const refillPerMs = capacity / this.windowMs;

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      this.buckets.set(identity, bucket);
      return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }
    this.buckets.set(identity, bucket);
    const deficit = cost - bucket.tokens;
    return { allowed: false, remaining: 0, retryAfterMs: Math.ceil(deficit / refillPerMs) };
  }

  /** Read current bucket state without consuming a token — for usage/status displays. */
  peek(identity: string, capacityOverride?: number): { remaining: number; limit: number } {
    const capacity = capacityOverride ?? this.capacity;
    const bucket = this.refill(identity, capacity);
    this.buckets.set(identity, bucket);
    return { remaining: Math.floor(bucket.tokens), limit: capacity };
  }

  /** Drop stale buckets to bound memory (call periodically). */
  evictIdle(maxIdleMs: number): void {
    const t = this.now();
    for (const [id, b] of this.buckets) {
      if (t - b.lastRefill > maxIdleMs) this.buckets.delete(id);
    }
  }
}
