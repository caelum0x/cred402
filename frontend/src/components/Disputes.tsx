import { useEffect, useState } from "react";
import type { Snapshot } from "../types";
import { fmtCspr, fmtTime, resolveDispute, getDisputeStats, type DisputeStats } from "../api";

const VERDICT_CLASS: Record<string, string> = {
  agent_wins: "ok",
  agent_loses: "bad",
  partial_fault: "warn",
  inconclusive: "",
  malicious_dispute: "bad",
};

export function Disputes({ snapshot, onChange }: { snapshot: Snapshot; onChange?: () => void }) {
  const disputes = [...snapshot.disputes].sort((a, b) => b.opened_at - a.opened_at);
  const [stats, setStats] = useState<DisputeStats | null>(null);
  useEffect(() => {
    getDisputeStats().then(setStats).catch(() => setStats(null));
  }, [snapshot.disputes.length, snapshot.slashes.length]);
  const totalSlashed = snapshot.slashes.reduce((s, x) => s + Number(x.amount), 0);
  const resolve = async (id: string, verdict: string, slash: number) => {
    await resolveDispute(id, verdict, slash);
    onChange?.();
  };

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Disputes" value={`${disputes.length}`} />
        <Stat label="Slashing events" value={`${snapshot.slashes.length}`} danger={snapshot.slashes.length > 0} />
        <Stat label="Total slashed" value={`${fmtCspr(totalSlashed)} CSPR`} />
        <Stat label="Insurance reserve" value={`${fmtCspr(snapshot.slashReserves.insurance_reserve ?? "0")} CSPR`} accent />
      </div>

      {stats && stats.total > 0 && (
        <div className="card wide">
          <h3>Dispute statistics</h3>
          <div className="stat-row">
            <Stat label="Resolution rate" value={`${(stats.resolution_rate * 100).toFixed(0)}%`} />
            <Stat label="Agent-loss rate" value={`${(stats.agent_loss_rate * 100).toFixed(0)}%`} danger={stats.agent_loss_rate > 0.5} />
            <Stat label="Open" value={`${stats.open}`} danger={stats.open > 0} />
            <Stat label="Most disputed" value={stats.most_disputed_agent ? `${stats.most_disputed_agent.agent_id} (${stats.most_disputed_agent.disputes})` : "—"} />
          </div>
          <div className="caps" style={{ marginTop: 6 }}>
            {Object.entries(stats.by_verdict).map(([v, n]) => (
              <span key={v} className={`chip ${VERDICT_CLASS[v] ?? ""}`}>{v}: {n}</span>
            ))}
            {Object.entries(stats.by_type).map(([t, n]) => (
              <span key={t} className="chip">{t}: {n}</span>
            ))}
          </div>
        </div>
      )}

      <div className="card wide">
        <h3>DisputeCourt</h3>
        {disputes.length === 0 && <p className="muted">No disputes — run "Dispute &amp; slash" to see the lifecycle.</p>}
        {disputes.map((d) => (
          <div key={d.dispute_id} className={`ev-row ${d.verdict ? VERDICT_CLASS[d.verdict] : ""}`} style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span><b>{d.dispute_type}</b> vs {d.respondent_agent}</span>
              <span className={`chip ${d.verdict ? VERDICT_CLASS[d.verdict] : "warn"}`}>{d.verdict ?? d.status}</span>
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              by {d.complainant} · {fmtTime(d.opened_at)} · slash {fmtCspr(d.slash_amount)} CSPR
            </div>
            {d.rationale.length > 0 && (
              <ul className="rationale" style={{ marginTop: 4 }}>
                {d.rationale.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}
            {d.status !== "resolved" && d.status !== "closed" && (
              <div className="controls" style={{ marginTop: 4 }}>
                <button className="btn danger" onClick={() => resolve(d.dispute_id, "agent_loses", 10)}>Rule against (slash 10)</button>
                <button className="btn" onClick={() => resolve(d.dispute_id, "agent_wins", 0)}>Rule for agent</button>
                <button className="btn" onClick={() => resolve(d.dispute_id, "malicious_dispute", 0)}>Malicious dispute</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="card wide">
        <h3>SlashingVault</h3>
        <table className="table">
          <thead><tr><th>Time</th><th>Agent</th><th>Amount</th><th>Reason</th></tr></thead>
          <tbody>
            {snapshot.slashes.length === 0 && <tr><td colSpan={4} className="muted">No slashes.</td></tr>}
            {snapshot.slashes.map((s) => (
              <tr key={s.slash_id}>
                <td>{fmtTime(s.timestamp)}</td>
                <td>{s.agent_id}</td>
                <td>{fmtCspr(s.amount)} CSPR</td>
                <td className="muted">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
