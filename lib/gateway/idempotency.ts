/**
 * Idempotency keys (p2 §7.1).
 *
 * A client may safely retry a mutating request by sending the same
 * `Idempotency-Key` header. The first request executes and its response is
 * cached; retries return the cached response instead of double-applying the
 * effect (e.g. opening two credit lines). Entries expire after a TTL.
 */

interface Entry {
  status: number;
  body: unknown;
  storedAt: number;
  /** Hash of the request body, so the same key with a different body is rejected. */
  fingerprint: string;
}

export interface IdempotencyHit {
  status: number;
  body: unknown;
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Look up a prior response for this key, validating the body fingerprint. */
  get(key: string, fingerprint: string): IdempotencyHit | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (this.now() - e.storedAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    if (e.fingerprint !== fingerprint) {
      // Same idempotency key, different payload — a client bug we must surface.
      throw new Error("idempotency key reused with a different request body");
    }
    return { status: e.status, body: e.body };
  }

  put(key: string, fingerprint: string, status: number, body: unknown): void {
    this.entries.set(key, { status, body, fingerprint, storedAt: this.now() });
  }
}
