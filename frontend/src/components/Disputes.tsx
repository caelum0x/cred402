import type { Snapshot } from "../types";
import { fmtCspr, fmtTime } from "../api";

const VERDICT_CLASS: Record<string, string> = {
  agent_wins: "ok",
  agent_loses: "bad",
  partial_fault: "warn",
  inconclusive: "",
  malicious_dispute: "bad",
};

export function Disputes({ snapshot }: { snapshot: Snapshot }) {
  const disputes = [...snapshot.disputes].sort((a, b) => b.opened_at - a.opened_at);
  const totalSlashed = snapshot.slashes.reduce((s, x) => s + Number(x.amount), 0);

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Disputes" value={`${disputes.length}`} />
        <Stat label="Slashing events" value={`${snapshot.slashes.length}`} danger={snapshot.slashes.length > 0} />
        <Stat label="Total slashed" value={`${fmtCspr(totalSlashed)} CSPR`} />
        <Stat label="Insurance reserve" value={`${fmtCspr(snapshot.slashReserves.insurance_reserve ?? "0")} CSPR`} accent />
      </div>

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
