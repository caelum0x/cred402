import { useEffect, useState } from "react";
import type { Snapshot } from "../types";
import { fmtCspr, fmtTime, getProposals, createProposal, voteProposal, executeProposal, applyProposal, type Proposal } from "../api";

async function post(path: string, body: unknown, then: () => void) {
  await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  then();
}

export function Governance({ snapshot, onChange }: { snapshot: Snapshot; onChange: () => void }) {
  const g = snapshot.governance;
  const [busy, setBusy] = useState(false);

  const togglePause = async (area: string, on: boolean) => {
    setBusy(true);
    await post("/api/governance/pause", { area, on }, onChange);
    setBusy(false);
  };
  const setParam = async (key: string, value: unknown) => {
    setBusy(true);
    await post("/api/governance/param", { key, value }, onChange);
    setBusy(false);
  };

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Protocol fee" value={`${(g.protocol_fee_bps / 100).toFixed(2)}%`} />
        <Stat label="Origination fee" value={`${(g.origination_fee_bps / 100).toFixed(2)}%`} />
        <Stat label="Min reputation to draw" value={`${g.min_reputation_to_draw}`} />
        <Stat label="Max agent exposure" value={`${fmtCspr(g.max_agent_exposure, 0)} CSPR`} />
      </div>

      <div className="card wide">
        <h3>Emergency controls</h3>
        <div className="controls">
          <Toggle label="Credit draws" on={g.paused_credit_draws} busy={busy} onToggle={(on) => togglePause("credit_draws", on)} />
          <Toggle label="Registrations" on={g.paused_registrations} busy={busy} onToggle={(on) => togglePause("registrations", on)} />
          <Toggle label="Receipt finalization" on={g.paused_receipt_finalization} busy={busy} onToggle={(on) => togglePause("receipt_finalization", on)} />
        </div>
        <div className="controls" style={{ marginTop: 10 }}>
          <button className="btn" disabled={busy} onClick={() => setParam("min_reputation_to_draw", g.min_reputation_to_draw + 5)}>
            Raise min reputation → {g.min_reputation_to_draw + 5}
          </button>
          <button className="btn" disabled={busy} onClick={() => setParam("origination_fee_bps", g.origination_fee_bps + 50)}>
            Raise origination fee → {((g.origination_fee_bps + 50) / 100).toFixed(2)}%
          </button>
        </div>
      </div>

      <div className="card wide">
        <h3>Parameter history</h3>
        <table className="table">
          <thead><tr><th>Time</th><th>Key</th><th>From</th><th>To</th></tr></thead>
          <tbody>
            {snapshot.governanceHistory.length === 0 && <tr><td colSpan={4} className="muted">No parameter changes yet.</td></tr>}
            {[...snapshot.governanceHistory].reverse().map((c, i) => (
              <tr key={i}>
                <td>{fmtTime(c.timestamp)}</td>
                <td><code>{c.key}</code></td>
                <td className="muted">{c.previous}</td>
                <td>{c.next}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Proposals />
    </div>
  );
}

function Proposals() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [form, setForm] = useState({ title: "Raise origination fee to 0.75%", param_key: "origination_fee_bps", new_value: 75, proposer: "EvidenceSellerAgent" });
  const [voter, setVoter] = useState("EvidenceSellerAgent");

  const load = () => getProposals().then(setProposals).catch(() => setProposals([]));
  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, []);

  return (
    <div className="card wide">
      <h3>Governance proposals</h3>
      <div className="controls">
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ flex: 1, minWidth: 200 }} />
        <input className="input" value={form.param_key} onChange={(e) => setForm({ ...form, param_key: e.target.value })} style={{ width: 180 }} />
        <input className="input" type="number" value={form.new_value} onChange={(e) => setForm({ ...form, new_value: Number(e.target.value) })} style={{ width: 90 }} />
        <button className="btn primary" onClick={() => createProposal(form).then(load)}>Propose</button>
      </div>
      <div className="controls">
        <span className="muted" style={{ alignSelf: "center" }}>Vote as:</span>
        <input className="input" value={voter} onChange={(e) => setVoter(e.target.value)} style={{ width: 180 }} />
      </div>
      <table className="table">
        <thead><tr><th>Proposal</th><th>Param → value</th><th>For / Against</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {proposals.length === 0 && <tr><td colSpan={5} className="muted">No proposals.</td></tr>}
          {proposals.map((p) => (
            <tr key={p.id}>
              <td>{p.title}</td>
              <td><code>{p.param_key}</code> → {String(p.new_value)}</td>
              <td>{p.votes_for} / {p.votes_against}</td>
              <td><span className={`chip ${p.status === "executed" ? "ok" : p.status === "rejected" ? "bad" : "warn"}`}>{p.status}</span></td>
              <td>
                {p.status === "open" && (
                  <>
                    <button className="btn" onClick={() => voteProposal(p.id, voter, true).then(load)}>👍</button>
                    <button className="btn" onClick={() => voteProposal(p.id, voter, false).then(load)}>👎</button>
                    <button className="btn primary" onClick={() => executeProposal(p.id).then(load)}>Tally</button>
                  </>
                )}
                {p.status === "queued" && (
                  <button className="btn primary" onClick={() => applyProposal(p.id).then((r) => (r.error ? alert(r.error.message) : load()))} title="Apply after timelock">Apply{p.eta ? ` (eta ${fmtTime(p.eta)})` : ""}</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Toggle({ label, on, busy, onToggle }: { label: string; on: boolean; busy: boolean; onToggle: (on: boolean) => void }) {
  return (
    <button className={`btn ${on ? "danger" : ""}`} disabled={busy} onClick={() => onToggle(!on)}>
      {label}: {on ? "PAUSED" : "active"}
    </button>
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
