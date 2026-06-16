import { useEffect, useState } from "react";
import { getAnalytics, getTimeseries, getCategoryAnalytics, getReputationMovers, fmtCspr, type AnalyticsView, type SeriesPoint, type CategoryStats, type Mover } from "../api";
import { AgentDetail } from "./AgentDetail";
import { Sparkline } from "./Sparkline";

/**
 * Analytics page — the live protocol dashboard: TVL/utilization, x402 throughput,
 * risk health, an agent revenue leaderboard, and a credit-flow timeline. Reads
 * /api/analytics, computed from the canonical ledger + event stream.
 */
export function Analytics() {
  const [a, setA] = useState<AnalyticsView | null>(null);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [categories, setCategories] = useState<CategoryStats[]>([]);
  const [movers, setMovers] = useState<{ gainers: Mover[]; losers: Mover[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    getAnalytics().then(setA).catch(() => setA(null));
    getTimeseries().then(setSeries).catch(() => setSeries([]));
    getCategoryAnalytics().then((c) => setCategories(c.categories)).catch(() => setCategories([]));
    getReputationMovers().then(setMovers).catch(() => setMovers(null));
    // Live updates over SSE; timeseries refreshed alongside each push.
    const es = new EventSource("/api/analytics/stream");
    es.addEventListener("analytics", (e) => {
      try {
        setA(JSON.parse((e as MessageEvent).data) as AnalyticsView);
        getTimeseries().then(setSeries).catch(() => {});
      } catch {
        /* ignore malformed frame */
      }
    });
    return () => es.close();
  }, []);

  if (!a) return <div className="empty">Loading analytics…</div>;

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="TVL" value={`${fmtCspr(a.pool.tvl_motes, 0)} CSPR`} accent />
        <Stat label="Outstanding" value={`${fmtCspr(a.pool.outstanding_motes)} CSPR`} />
        <Stat label="Utilization" value={`${(a.pool.utilization * 100).toFixed(1)}%`} />
        <Stat label="x402 volume" value={`${fmtCspr(a.x402.total_volume_motes, 4)} CSPR`} />
        <Stat label="Agents" value={`${a.totals.agents}`} />
        <Stat label="Receipts" value={`${a.totals.receipts}`} />
        <Stat label="High-fraud" value={`${a.risk.high_fraud_agents}`} danger={a.risk.high_fraud_agents > 0} />
        <Stat label="Defaults" value={`${a.pool.defaults}`} danger={a.pool.defaults > 0} />
      </div>

      {series.length > 1 && (
        <div className="card wide">
          <h3>Trends</h3>
          <div className="spark-row">
            <Sparkline values={series.map((p) => p.liquidity)} color="#3fd07a" label="Liquidity (CSPR)" />
            <Sparkline values={series.map((p) => p.outstanding)} color="#f5b73d" label="Outstanding (CSPR)" />
            <Sparkline values={series.map((p) => p.receipts)} color="#7c8aff" label="Receipts" />
          </div>
        </div>
      )}

      <div className="card wide">
        <h3>Agent leaderboard <a className="csv-link" href="/api/export/leaderboard.csv" download>⤓ CSV</a></h3>
        <table className="table">
          <thead><tr><th>#</th><th>Agent</th><th>Tier</th><th>Service</th><th>Revenue</th><th>Receipts</th><th>Reputation</th><th>Credit score</th><th>Credit line</th><th>Fraud</th></tr></thead>
          <tbody>
            {a.leaderboard.map((r, i) => (
              <tr key={r.agent_id} className="clickable" onClick={() => setSelected(r.agent_id)}>
                <td>{i + 1}</td>
                <td>{r.agent_id}</td>
                <td><span className={`chip ${["gold", "platinum", "diamond"].includes(r.tier) ? "ok" : ""}`}>{r.tier}</span></td>
                <td className="muted">{r.service_type}</td>
                <td>{fmtCspr(r.revenue_motes)} CSPR</td>
                <td>{r.receipts}</td>
                <td>{r.reputation}/100</td>
                <td>{r.credit_score}/100</td>
                <td>{fmtCspr(r.credit_line_motes)} CSPR</td>
                <td><span className={`chip ${r.fraud_score >= 70 ? "bad" : r.fraud_score > 0 ? "warn" : "ok"}`}>{r.fraud_score}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {categories.length > 0 && (
        <div className="card wide">
          <h3>Market by service category</h3>
          <table className="table">
            <thead><tr><th>Category</th><th>Agents</th><th>Avg rep</th><th>Avg credit</th><th>Receipts</th><th>Revenue</th><th>Top agent</th></tr></thead>
            <tbody>
              {categories.map((c) => (
                <tr key={c.category}>
                  <td>{c.category}</td>
                  <td>{c.agent_count}</td>
                  <td>{c.avg_reputation}/100</td>
                  <td>{c.avg_credit_score}/100</td>
                  <td>{c.total_receipts}</td>
                  <td>{fmtCspr(c.total_revenue_motes)} CSPR</td>
                  <td className="muted">{c.top_agent ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {movers && (movers.gainers.length > 0 || movers.losers.length > 0) && (
        <div className="card wide">
          <h3>Reputation movers</h3>
          <div className="caps">
            {movers.gainers.map((m) => (
              <span key={m.agent_id} className="chip ok" title={`${m.events} updates`}>▲ {m.agent_id} +{m.change} → {m.current}</span>
            ))}
            {movers.losers.map((m) => (
              <span key={m.agent_id} className="chip bad" title={`${m.events} updates`}>▼ {m.agent_id} {m.change} → {m.current}</span>
            ))}
          </div>
        </div>
      )}

      <div className="card wide">
        <h3>Credit flow timeline</h3>
        <div className="caps">
          {a.credit_timeline.length === 0 && <span className="muted">No credit events yet.</span>}
          {a.credit_timeline.map((p) => (
            <span key={p.seq} className={`chip ${p.event === "CreditDefaulted" ? "bad" : p.event === "CreditRepaid" ? "ok" : ""}`} title={`seq ${p.seq}`}>
              {p.event.replace("Credit", "")}{p.agent_id ? ` · ${p.agent_id}` : ""}{p.amount_motes ? ` · ${fmtCspr(p.amount_motes)}` : ""}
            </span>
          ))}
        </div>
      </div>

      {selected && <AgentDetail agentId={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function Stat({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""} ${danger ? "danger" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
