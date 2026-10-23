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
  /** Which {@link Org} this key belongs to. Undefined for the platform bootstrap/admin key — it is orgless by design, not a tenant. */
  org_id?: string;
  /** Successful-auth count — the basis for per-org usage reporting (org usage = sum over its keys). */
  request_count: number;
}

export interface IssuedKey {
  id: string;
  /** The full secret — returned ONCE, never stored or logged. */
  secret: string;
  scopes: Scope[];
  org_id?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export class ApiKeyStore {
  private readonly keys = new Map<string, ApiKeyRecord>(); // by id

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** Mint a new key. The secret is `c402_<id>_<random>`; only its hash is kept. */
  issue(name: string, scopes: Scope[], orgId?: string): IssuedKey {
    const id = "k_" + randomBytes(6).toString("hex");
    const secretPart = randomBytes(24).toString("base64url");
    const secret = `c402_${id}_${secretPart}`;
    this.keys.set(id, { id, name, hash: sha256(secret), scopes, created_at: this.now(), org_id: orgId, request_count: 0 });
    return { id, secret, scopes, org_id: orgId };
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
    record.request_count += 1;
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

  /** Keys belonging to one org — the tenant-scoped view a non-admin org key is allowed to see. */
  listByOrg(orgId: string): Array<Omit<ApiKeyRecord, "hash">> {
    return this.list().filter((k) => k.org_id === orgId);
  }

  get(id: string): ApiKeyRecord | undefined {
    return this.keys.get(id);
  }

  hasScope(record: ApiKeyRecord, scope: Scope): boolean {
    return record.scopes.includes("admin") || record.scopes.includes(scope);
  }
}
