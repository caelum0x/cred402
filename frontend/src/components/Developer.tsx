import { useEffect, useState } from "react";
import {
  listApiKeys, createApiKey, listWebhooks, createWebhook, runGraphQL, getProtocolConfig, fmtCspr,
  type ApiKeyMeta, type WebhookMeta, type ProtocolConfig,
} from "../api";

/**
 * Developer portal — manage production API keys + webhooks (the /v1/admin surface),
 * run live GraphQL queries, and read the protocol rulebook. The console talks to the
 * real gateway, so keys minted here authenticate real /v1 requests and webhooks fire.
 */
export function Developer() {
  return (
    <div className="pool">
      <ProtocolRulebook />
      <ApiKeys />
      <Webhooks />
      <GraphQLConsole />
    </div>
  );
}

function ProtocolRulebook() {
  const [cfg, setCfg] = useState<ProtocolConfig | null>(null);
  useEffect(() => {
    getProtocolConfig().then(setCfg).catch(() => setCfg(null));
  }, []);
  if (!cfg) return null;
  return (
    <div className="card wide">
      <h3>Protocol rulebook <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>· policy {cfg.policy_version} · GET /v1/config</span></h3>
      <div className="stat-row">
        <Stat label="Facilitator fee" value={`${(cfg.fees.facilitator_fee_bps / 100).toFixed(2)}%`} />
        <Stat label="Origination fee" value={`${(cfg.fees.origination_fee_bps / 100).toFixed(2)}%`} />
        <Stat label="Interest → protocol" value={`${(cfg.fees.interest_spread_bps / 100).toFixed(0)}%`} />
        <Stat label="Min reputation" value={`${cfg.governance.min_reputation_to_draw}`} />
        <Stat label="Max exposure" value={`${fmtCspr(cfg.governance.max_agent_exposure_motes, 0)} CSPR`} />
      </div>
      <table className="table">
        <thead><tr><th>Tier</th><th>Min reputation</th><th>Credit multiplier</th><th>Origination discount</th></tr></thead>
        <tbody>
          {cfg.reputation_tiers.map((t) => (
            <tr key={t.tier}>
              <td><span className={`chip ${["gold", "platinum", "diamond"].includes(t.tier) ? "ok" : ""}`}>{t.tier}</span></td>
              <td>{t.min_reputation}</td>
              <td>×{t.credit_multiplier}</td>
              <td>{t.origination_discount_bps} bps</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function ApiKeys() {
  const [keys, setKeys] = useState<ApiKeyMeta[]>([]);
  const [name, setName] = useState("my-app");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [secret, setSecret] = useState<string | null>(null);

  const load = () => listApiKeys().then(setKeys).catch(() => setKeys([]));
  useEffect(() => { load(); }, []);

  const create = async () => {
    const issued = await createApiKey(name, scopes);
    setSecret(issued.secret);
    load();
  };

  const toggle = (s: string) =>
    setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <div className="card wide">
      <h3>API keys</h3>
      <div className="controls">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="key name" />
        {["read", "write", "admin"].map((s) => (
          <button key={s} className={`tab ${scopes.includes(s) ? "active" : ""}`} onClick={() => toggle(s)}>{s}</button>
        ))}
        <button className="btn primary" onClick={create} disabled={!name || scopes.length === 0}>Mint key</button>
      </div>
      {secret && (
        <p className="muted">New secret (shown once): <code>{secret}</code></p>
      )}
      <table className="table">
        <thead><tr><th>Id</th><th>Name</th><th>Scopes</th><th>Status</th></tr></thead>
        <tbody>
          {keys.length === 0 && <tr><td colSpan={4} className="muted">No API keys yet.</td></tr>}
          {keys.map((k) => (
            <tr key={k.id}>
              <td><code>{k.id}</code></td>
              <td>{k.name}</td>
              <td>{k.scopes.map((s) => <span key={s} className="chip">{s}</span>)}</td>
              <td><span className={`chip ${k.revoked_at ? "bad" : "ok"}`}>{k.revoked_at ? "revoked" : "active"}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Webhooks() {
  const [hooks, setHooks] = useState<WebhookMeta[]>([]);
  const [url, setUrl] = useState("https://example.com/cred402-hook");
  const [secret, setSecret] = useState<string | null>(null);

  const load = () => listWebhooks().then(setHooks).catch(() => setHooks([]));
  useEffect(() => { load(); }, []);

  const create = async () => {
    const sub = await createWebhook(url, ["*"]);
    setSecret(sub.secret);
    load();
  };

  return (
    <div className="card wide">
      <h3>Webhooks</h3>
      <div className="controls">
        <input className="input" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <button className="btn primary" onClick={create} disabled={!/^https?:\/\//.test(url)}>Subscribe</button>
      </div>
      {secret && <p className="muted">Signing secret (shown once): <code>{secret}</code> — verify <code>X-Cred402-Signature</code></p>}
      <table className="table">
        <thead><tr><th>Id</th><th>URL</th><th>Events</th></tr></thead>
        <tbody>
          {hooks.length === 0 && <tr><td colSpan={3} className="muted">No webhooks.</td></tr>}
          {hooks.map((h) => (
            <tr key={h.id}>
              <td><code>{h.id}</code></td>
              <td className="muted">{h.url}</td>
              <td>{h.events.map((e) => <span key={e} className="chip">{e}</span>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SAMPLE = `{
  agents { agent_id reputation_score credit_score }
  creditPool
  analytics
}`;

function GraphQLConsole() {
  const [query, setQuery] = useState(SAMPLE);
  const [result, setResult] = useState("");

  const run = async () => {
    try {
      setResult(JSON.stringify(await runGraphQL(query), null, 2));
    } catch (e) {
      setResult(String(e));
    }
  };

  return (
    <div className="card wide">
      <h3>GraphQL console <span className="muted">POST /graphql</span></h3>
      <textarea className="input" style={{ width: "100%", minHeight: 120, fontFamily: "monospace" }} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="controls"><button className="btn primary" onClick={run}>Run query</button></div>
      {result && <pre className="json-out">{result}</pre>}
    </div>
  );
}
