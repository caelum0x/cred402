import { randomBytes } from "node:crypto";

/**
 * Organizations — multi-tenant grouping for API keys (p2 §7.1 follow-up).
 *
 * Every paying integrator gets exactly one {@link Org}. The platform operator
 * mints an org's first key (scopes `["read","write"]`, never `admin`) via the
 * `admin`-scoped `POST /v1/orgs` route; from then on the org is self-service —
 * any key that belongs to the org can mint sibling keys for teammates
 * (`POST /v1/orgs/keys`, capped to a subset of its own scopes so a `read`-only
 * key can never mint a `write` key) and can only ever see or revoke keys in
 * its OWN org (`GET`/`DELETE /v1/orgs/keys/:id`) — the platform `admin` key
 * is the only credential that can see across orgs. This is the actual
 * tenant-isolation boundary: distinct orgs cannot enumerate, revoke, or
 * impersonate each other's credentials even though they share one process.
 */

export type Plan = "free" | "pro" | "enterprise";

export interface Org {
  id: string;
  name: string;
  plan: Plan;
  created_at: number;
}

export class OrgStore {
  private readonly orgs = new Map<string, Org>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(name: string, plan: Plan = "free"): Org {
    const org: Org = { id: "org_" + randomBytes(6).toString("hex"), name, plan, created_at: this.now() };
    this.orgs.set(org.id, org);
    return org;
  }

  get(id: string): Org | undefined {
    return this.orgs.get(id);
  }

  list(): Org[] {
    return [...this.orgs.values()];
  }

  exists(id: string): boolean {
    return this.orgs.has(id);
  }
}
