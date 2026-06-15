import { randomBytes, createHash, timingSafeEqual } from "node:crypto";

/**
 * API key management (p2 §7.1).
 *
 * Keys are shown to the caller exactly once at creation; only a SHA-256 hash is
 * stored, so a leak of the key store does not reveal usable credentials.
 * Verification is constant-time. Each key carries scopes that authorize specific
 * route groups (read, write, admin).
 */

export type Scope = "read" | "write" | "admin";

export interface ApiKeyRecord {
  id: string; // public key id (safe to log)
  name: string;
  hash: string; // sha256(secret) hex
  scopes: Scope[];
  created_at: number;
  revoked_at?: number;
  last_used_at?: number;
}

export interface IssuedKey {
  id: string;
  /** The full secret — returned ONCE, never stored or logged. */
  secret: string;
  scopes: Scope[];
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export class ApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>(); // by id

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Mint a new key. The secret is `c402_<id>_<random>`; only its hash is kept. */
  issue(name: string, scopes: Scope[]): IssuedKey {
    const id = "k_" + randomBytes(6).toString("hex");
    const secretPart = randomBytes(24).toString("base64url");
    const secret = `c402_${id}_${secretPart}`;
    this.keys.set(id, { id, name, hash: sha256(secret), scopes, created_at: this.now() });
    return { id, secret, scopes };
  }

  /** Verify a presented secret and return its record, or undefined if invalid. */
  verify(secret: string | undefined): ApiKeyRecord | undefined {
    if (!secret) return undefined;
    const m = /^c402_(k_[0-9a-f]{12})_/.exec(secret);
    if (!m) return undefined;
    const record = this.keys.get(m[1]!);
    if (!record || record.revoked_at) return undefined;
    const presented = Buffer.from(sha256(secret));
    const stored = Buffer.from(record.hash);
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return undefined;
    record.last_used_at = this.now();
    return record;
  }

  revoke(id: string): boolean {
    const record = this.keys.get(id);
    if (!record || record.revoked_at) return false;
    record.revoked_at = this.now();
    return true;
  }

  /** Public metadata only — never includes the hash. */
  list(): Array<Omit<ApiKeyRecord, "hash">> {
    return [...this.keys.values()].map(({ hash: _hash, ...rest }) => rest);
  }

  hasScope(record: ApiKeyRecord, scope: Scope): boolean {
    return record.scopes.includes("admin") || record.scopes.includes(scope);
  }
}
