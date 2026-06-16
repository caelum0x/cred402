import { useEffect, useState } from "react";
import { getIncidents, pauseProtocol, getCreditHealth, freezeLine, getRiskAlerts, getFleetOverview, fmtCspr, type Incidents, type CreditHealthLine, type RiskAlertReport, type FleetOverview } from "../api";

/**
 * Ops / incident board (internal-admin) — the on-call view: fraud watchlist,
 * frozen/defaulted credit lines, open disputes, and emergency pause switches that
 * call the real governance pause endpoints.
 */
export function Ops() {
  const [inc, setInc] = useState<Incidents | null>(null);
  const [health, setHealth] = useState<CreditHealthLine[]>([]);
  const [alerts, setAlerts] = useState<RiskAlertReport | null>(null);
  const [fleetIds, setFleetIds] = useState("");
  const [fleet, setFleet] = useState<FleetOverview | null>(null);

  const checkFleet = async () => {
    const ids = fleetIds.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return;
    setFleet(await getFleetOverview(ids).catch(() => null));
  };

  const load = () => {
    getIncidents().then(setInc).catch(() => setInc(null));
    getCreditHealth().then(setHealth).catch(() => setHealth([]));
    getRiskAlerts().then(setAlerts).catch(() => setAlerts(null));
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const freeze = async (id: string) => {
    await freezeLine(id);
    load();
  };

  const toggle = async (area: "credit_draws" | "registrations" | "receipt_finalization", on: boolean) => {
    await pauseProtocol(area, on);
    load();
  };

  if (!inc) return <div className="empty">Loading incidents…</div>;

  return (
    <div className="pool">
      <div className="card wide">
        <h3>Emergency controls</h3>
        <div className="controls">
          {(["credit_draws", "registrations", "receipt_finalization"] as const).map((area) => {
            const paused = inc.paused[area];
            return (
              <button key={area} className={`btn ${paused ? "danger" : ""}`} onClick={() => toggle(area, !paused)}>
                {paused ? `▶ Resume ${area}` : `⏸ Pause ${area}`}
              </button>
            );
          })}
        </div>
      </div>

      {alerts && (
        <div className="card wide">
          <h3>
            Risk alerts{" "}
            {alerts.counts.critical > 0 && <span className="chip bad">{alerts.counts.critical} critical</span>}{" "}
            {alerts.counts.warning > 0 && <span className="chip warn">{alerts.counts.warning} warning</span>}
          </h3>
          {alerts.alerts.length === 0 ? (
            <p className="muted">✓ No active risk alerts — the book is clean.</p>
          ) : (
            <div className="caps" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
              {alerts.alerts.map((a, i) => (
                <div key={i} className="rowline">
                  <span className={`chip ${a.severity === "critical" ? "bad" : a.severity === "warning" ? "warn" : "ok"}`}>{a.severity}</span>{" "}
                  <strong>{a.code}</strong> <span className="muted">· {a.subject}</span> — {a.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card wide">
        <h3>Operator fleet overview</h3>
        <div className="controls" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            className="input"
            style={{ flex: 1, minWidth: 280 }}
            placeholder="agent ids (comma or space separated)"
            value={fleetIds}
            onChange={(e) => setFleetIds(e.target.value)}
          />
          <button className="btn primary" disabled={!fleetIds.trim()} onClick={checkFleet}>Check fleet</button>
          {fleet && <span className="muted" style={{ alignSelf: "center" }}>{fleet.ready} ready · {fleet.not_ready} not ready · {fleet.unknown} unknown</span>}
        </div>
        {fleet && fleet.agents.length > 0 && (
          <table className="table" style={{ marginTop: 8 }}>
            <thead><tr><th>Agent</th><th>Tier</th><th>Discovery</th><th>Reputation</th><th>Readiness</th><th>Line</th></tr></thead>
            <tbody>
              {fleet.agents.map((a) => (
                <tr key={a.agent_id}>
                  <td>{a.agent_id}</td>
                  {a.exists ? (
                    <>
                      <td><span className={`chip ${["gold", "platinum", "diamond"].includes(a.tier ?? "") ? "ok" : ""}`}>{a.tier}</span></td>
                      <td>{a.discovery_score}</td>
                      <td>{a.reputation}/100</td>
                      <td><span className={`chip ${a.ready ? "ok" : "warn"}`}>{a.ready ? "ready" : "not ready"} {a.readiness_pct}%</span></td>
                      <td>{a.has_credit_line ? `${fmtCspr(a.drawn_motes ?? "0")} CSPR drawn` : "—"}</td>
                    </>
                  ) : (
                    <td colSpan={5}><span className="chip bad">unknown agent</span></td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="stat-row">
        <Stat label="Fraud watchlist" value={`${inc.fraud_watchlist.length}`} danger={inc.fraud_watchlist.length > 0} />
        <Stat label="Frozen lines" value={`${inc.frozen_lines.length}`} danger={inc.frozen_lines.length > 0} />
        <Stat label="Defaulted lines" value={`${inc.defaulted_lines.length}`} danger={inc.defaulted_lines.length > 0} />
        <Stat label="Open disputes" value={`${inc.open_disputes.length}`} danger={inc.open_disputes.length > 0} />
        <Stat label="Defaults total" value={`${inc.defaults_total}`} />
      </div>

      <div className="card wide">
        <h3>Credit-line health</h3>
        <table className="table">
          <thead><tr><th>Agent</th><th>Drawn / Max</th><th>Utilization</th><th>Health</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {health.length === 0 && <tr><td colSpan={6} className="muted">No credit lines.</td></tr>}
            {health.map((l) => (
              <tr key={l.agent_id}>
                <td>{l.agent_id}</td>
                <td>{fmtCspr(l.drawn_motes)} / {fmtCspr(l.max_credit_motes)} CSPR</td>
                <td>{(l.utilization * 100).toFixed(0)}%</td>
                <td><span className={`chip ${l.overdue ? "bad" : "ok"}`}>{l.overdue ? "overdue" : (l.health_factor_bps / 100).toFixed(0) + "%"}</span></td>
                <td><span className={`chip ${l.status === "active" ? "ok" : "bad"}`}>{l.status}</span></td>
                <td>{l.status === "active" && <button className="btn danger" onClick={() => freeze(l.agent_id)}>Freeze</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>Fraud watchlist</h3>
        <table className="table">
          <thead><tr><th>Agent</th><th>Score</th><th>Flags</th></tr></thead>
          <tbody>
            {inc.fraud_watchlist.length === 0 && <tr><td colSpan={3} className="muted">No agents above the fraud threshold.</td></tr>}
            {inc.fraud_watchlist.map((f) => (
              <tr key={f.agent_id}>
                <td>{f.agent_id}</td>
                <td><span className={`chip ${f.score >= 70 ? "bad" : "warn"}`}>{f.score}</span></td>
                <td>{f.flags.map((x) => <span key={x} className="chip">{x}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>Open disputes</h3>
        <table className="table">
          <thead><tr><th>Dispute</th><th>Respondent</th><th>Type</th><th>Status</th></tr></thead>
          <tbody>
            {inc.open_disputes.length === 0 && <tr><td colSpan={4} className="muted">No open disputes.</td></tr>}
            {inc.open_disputes.map((d) => (
              <tr key={d.dispute_id}>
                <td><code>{d.dispute_id}</code></td>
                <td>{d.respondent}</td>
                <td><span className="chip">{d.type}</span></td>
                <td><span className="chip warn">{d.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className={`stat ${danger ? "danger" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
