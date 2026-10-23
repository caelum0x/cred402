import { useEffect, useState } from "react";
import {
  listWebhooks,
  createWebhook,
  disableWebhook,
  enableWebhook,
  listWebhookDeliveries,
  retryWebhookDelivery,
  type WebhookMeta,
  type WebhookDelivery,
} from "../api";

/**
 * Webhook delivery dashboard — manage outbound event subscriptions and
 * inspect/replay individual deliveries against the real gateway
 * (`/v1/webhooks*`). A "retry" re-sends the exact original payload, signed
 * the same way the original dispatch was, to the subscriber's URL — useful
 * once an integrator fixes a receiving endpoint that was down or erroring.
 */
export function Webhooks() {
  const [hooks, setHooks] = useState<WebhookMeta[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [filter, setFilter] = useState("all");
  const [url, setUrl] = useState("https://example.com/cred402-hook");
  const [secret, setSecret] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const loadHooks = () => listWebhooks().then(setHooks).catch(() => setHooks([]));
  const loadDeliveries = () =>
    listWebhookDeliveries(filter === "all" ? undefined : filter)
      .then(setDeliveries)
      .catch(() => setDeliveries([]));

  useEffect(() => {
    loadHooks();
  }, []);

  useEffect(() => {
    loadDeliveries();
    const id = setInterval(loadDeliveries, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const create = async () => {
    const sub = await createWebhook(url, ["*"]);
    setSecret(sub.secret);
    loadHooks();
  };

  const toggle = async (h: WebhookMeta) => {
    setToggling(h.id);
    try {
      if (h.disabled_at) await enableWebhook(h.id);
      else await disableWebhook(h.id);
      await loadHooks();
    } finally {
      setToggling(null);
    }
  };

  const retry = async (d: WebhookDelivery) => {
    setRetrying(d.id);
    try {
      await retryWebhookDelivery(d.id);
      await loadDeliveries();
    } finally {
      setRetrying(null);
    }
  };

  const subscriberUrl = (subscriptionId: string) => hooks.find((h) => h.id === subscriptionId)?.url ?? subscriptionId;

  return (
    <div className="card wide">
      <h3>
        Webhooks{" "}
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          · POST /v1/webhooks · GET /v1/webhooks/deliveries
        </span>
      </h3>
      <div className="controls">
        <input className="input" style={{ flex: 1 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        <button className="btn primary" onClick={create} disabled={!/^https?:\/\//.test(url)}>
          Subscribe
        </button>
      </div>
      {secret && (
        <p className="muted">
          Signing secret (shown once): <code>{secret}</code> — verify <code>X-Cred402-Signature</code>
        </p>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>Id</th>
            <th>URL</th>
            <th>Events</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {hooks.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No webhooks.
              </td>
            </tr>
          )}
          {hooks.map((h) => (
            <tr key={h.id}>
              <td>
                <code>{h.id}</code>
              </td>
              <td className="muted">{h.url}</td>
              <td>
                {h.events.map((e) => (
                  <span key={e} className="chip">
                    {e}
                  </span>
                ))}
              </td>
              <td>
                <span className={`chip ${h.disabled_at ? "bad" : "ok"}`}>{h.disabled_at ? "disabled" : "active"}</span>
              </td>
              <td>
                <button className="btn ghost" disabled={toggling === h.id} onClick={() => toggle(h)}>
                  {h.disabled_at ? "↻ enable" : "⏸ disable"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4 style={{ marginTop: 18, marginBottom: 8 }}>Delivery log</h4>
      <div className="controls">
        <select className="input" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">All subscriptions</option>
          {hooks.map((h) => (
            <option key={h.id} value={h.id}>
              {h.url}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={loadDeliveries}>
          ⟳ refresh
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Subscriber</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {deliveries.length === 0 && (
            <tr>
              <td colSpan={7} className="muted">
                No deliveries yet — fire a protocol event (register an agent, draw/repay credit…) to see one land here.
              </td>
            </tr>
          )}
          {deliveries.map((d) => (
            <tr key={d.id}>
              <td className="muted">{new Date(d.at).toLocaleTimeString()}</td>
              <td>
                {d.event}
                {d.replay_of && <span className="chip" style={{ marginLeft: 6 }}>replay</span>}
              </td>
              <td className="muted">{subscriberUrl(d.subscription_id)}</td>
              <td>
                <span className={`chip ${d.status === "delivered" ? "ok" : "bad"}`}>
                  {d.status}
                  {d.http_status ? ` ${d.http_status}` : ""}
                </span>
              </td>
              <td>{d.attempts}</td>
              <td className="muted">{d.error ?? "—"}</td>
              <td>
                {d.status === "failed" && (
                  <button className="btn ghost" disabled={retrying === d.id} onClick={() => retry(d)}>
                    {retrying === d.id ? "…" : "↻ retry"}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
