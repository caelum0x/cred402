import { useEffect, useState } from "react";
import {
  listApiKeys, createApiKey, listWebhooks, createWebhook, runGraphQL,
  type ApiKeyMeta, type WebhookMeta,
} from "../api";

/**
 * Developer portal — manage production API keys + webhooks (the /v1/admin surface)
 * and run live GraphQL queries. The console talks to the real gateway, so keys
 * minted here authenticate real /v1 requests and webhooks really fire.
 */
export function Developer() {
  return (
    <div className="pool">
      <ApiKeys />
      <Webhooks />
      <GraphQLConsole />
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
