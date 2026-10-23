import { useState } from "react";
import {
  createOrg,
  listOrgs,
  getMyOrg,
  getOrgUsage,
  mintOrgKey,
  revokeOrgKey,
  type Org,
  type OrgUsage,
  type OrgWithKeys,
} from "../api";

/**
 * Organizations — multi-tenant API-key scoping (`/v1/orgs*`).
 *
 * Two distinct flows, kept visually separate because they use two distinct
 * credentials against the real gateway:
 *
 * 1. Platform operator ("you") onboards a new paying integrator once —
 *    `POST /v1/orgs` — and gets back that org's first key.
 * 2. From then on the ORG is self-service: paste its own key below and it
 *    can see its profile, mint sibling keys for teammates (capped to a
 *    subset of its own scopes — no escalation), and revoke keys — all
 *    scoped so it can never see or touch another org's keys, even with a
 *    valid non-admin key. The platform admin key is never used past step 1.
 */
export function Orgs() {
  return (
    <div className="pool">
      <OperatorOnboarding />
      <SelfService />
    </div>
  );
}

function OperatorOnboarding() {
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("Acme Corp");
  const [plan, setPlan] = useState<Org["plan"]>("free");
  const [minted, setMinted] = useState<{ org: Org; secret: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => listOrgs().then((l) => { setOrgs(l); setLoaded(true); }).catch(() => setLoaded(true));

  const create = async () => {
    setBusy(true);
    try {
      const { org, owner_key } = await createOrg(name, plan);
      setMinted({ org, secret: owner_key.secret });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card wide">
      <h3>
        Organizations (operator){" "}
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          · POST /v1/orgs · admin-scoped, onboards a new tenant once
        </span>
      </h3>
      <div className="controls">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="organization name" />
        <select className="input" value={plan} onChange={(e) => setPlan(e.target.value as Org["plan"])}>
          <option value="free">free</option>
          <option value="pro">pro</option>
          <option value="enterprise">enterprise</option>
        </select>
        <button className="btn primary" onClick={create} disabled={!name || busy}>
          + Onboard org
        </button>
        {!loaded && (
          <button className="btn ghost" onClick={load}>
            ⟳ load orgs
          </button>
        )}
      </div>
      {minted && (
        <p className="muted">
          <code>{minted.org.name}</code> owner secret (shown once — hand this to the customer, never store it here):{" "}
          <code>{minted.secret}</code>
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Id</th>
            <th>Name</th>
            <th>Plan</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {loaded && orgs.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No organizations yet.
              </td>
            </tr>
          )}
          {orgs.map((o) => (
            <tr key={o.id}>
              <td>
                <code>{o.id}</code>
              </td>
              <td>{o.name}</td>
              <td>
                <span className="chip">{o.plan}</span>
              </td>
              <td className="muted">{new Date(o.created_at).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SelfService() {
  const [secret, setSecret] = useState("");
  const [org, setOrg] = useState<OrgWithKeys | null>(null);
  const [usage, setUsage] = useState<OrgUsage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyName, setKeyName] = useState("teammate");
  const [scopes, setScopes] = useState<Array<"read" | "write">>(["read"]);
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async (s: string) => {
    setError(null);
    try {
      const [o, u] = await Promise.all([getMyOrg(s), getOrgUsage(s)]);
      setOrg(o);
      setUsage(u);
    } catch (e) {
      setOrg(null);
      setUsage(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const mint = async () => {
    setBusy(true);
    try {
      const k = await mintOrgKey(secret, keyName, scopes);
      setIssued(k.secret);
      await load(secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    try {
      await revokeOrgKey(secret, id);
      await load(secret);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleScope = (s: "read" | "write") =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="card wide">
      <h3>
        Your organization (self-service){" "}
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          · GET /v1/orgs/me · POST /v1/orgs/keys · DELETE /v1/orgs/keys/:id — authenticates as YOUR org's own key, never the
          platform admin key
        </span>
      </h3>
      <div className="controls">
        <input
          className="input"
          style={{ flex: 1 }}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="paste an org owner/member secret (c402_k_…)"
          type="password"
        />
        <button className="btn primary" onClick={() => load(secret)} disabled={!secret}>
          Load my org
        </button>
      </div>
      {error && <p className="muted">⚠ {error}</p>}
      {org && (
        <>
          <div className="stat-row">
            <div className="stat">
              <span className="stat-label">Organization</span>
              <span className="stat-value">{org.name}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Plan</span>
              <span className="stat-value">{org.plan}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Keys</span>
              <span className="stat-value">{org.keys.length}</span>
            </div>
            {usage && (
              <div className="stat">
                <span className="stat-label">Total requests</span>
                <span className="stat-value">{usage.total_requests}</span>
              </div>
            )}
          </div>
          {usage && (
            <>
              <OrgRateLimitMeter usage={usage} />
              <p className="muted" style={{ marginTop: -4 }}>
                One shared rate-limit bucket for the whole org (sized by plan) — minting more teammate keys does not
                multiply the limit.
              </p>
            </>
          )}
          <table className="table">
            <thead>
              <tr>
                <th>Id</th>
                <th>Name</th>
                <th>Scopes</th>
                <th>Requests</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {org.keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <code>{k.id}</code>
                  </td>
                  <td>{k.name}</td>
                  <td>
                    {k.scopes.map((s) => (
                      <span key={s} className="chip">
                        {s}
                      </span>
                    ))}
                  </td>
                  <td className="muted">{k.request_count ?? 0}</td>
                  <td>
                    <span className={`chip ${k.revoked_at ? "bad" : "ok"}`}>{k.revoked_at ? "revoked" : "active"}</span>
                  </td>
                  <td>
                    {!k.revoked_at && (
                      <button className="btn ghost" disabled={busy} onClick={() => revoke(k.id)}>
                        ✗ revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 style={{ marginTop: 18, marginBottom: 8 }}>Mint a teammate key</h4>
          <div className="controls">
            <input className="input" value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="key name" />
            {(["read", "write"] as const).map((s) => (
              <button key={s} className={`tab ${scopes.includes(s) ? "active" : ""}`} onClick={() => toggleScope(s)}>
                {s}
              </button>
            ))}
            <button className="btn primary" onClick={mint} disabled={busy || !keyName || scopes.length === 0}>
              + Mint key
            </button>
          </div>
          <p className="muted">A read-only key cannot mint itself a write key — scope escalation is rejected server-side.</p>
          {issued && (
            <p className="muted">
              New secret (shown once): <code>{issued}</code>
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Org-scoped rate-limit bucket status — one bar for the whole org, not per key. */
function OrgRateLimitMeter({ usage }: { usage: OrgUsage }) {
  const { limit, remaining } = usage.rate_limit;
  const used = Math.max(0, limit - remaining);
  const pct = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
  const windowSec = Math.round(usage.rate_limit.window_ms / 1000);
  return (
    <div className="meter">
      <div className="meter-top">
        <span>
          Rate limit (<span className="chip">{usage.plan}</span> plan · per {windowSec}s window)
        </span>
        <b>
          {remaining} / {limit} left
        </b>
      </div>
      <div className="bar">
        <div className={`fill ${pct > 85 ? "" : "accent"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
