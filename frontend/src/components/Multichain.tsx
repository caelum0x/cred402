import { useState } from "react";
import type { Snapshot } from "../types";
import { fmtTime } from "../api";

function usd(microStr: string): string {
  return `$${(Number(microStr) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function Multichain({ snapshot, onChange }: { snapshot: Snapshot; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await fetch("/api/demo/multichain", { method: "POST" });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const bindings = snapshot.addressBindings ?? [];
  const ext = snapshot.externalReceipts ?? [];
  const exposure = snapshot.globalExposure ?? [];
  const cans = snapshot.creditNotes ?? [];

  return (
    <div className="pool">
      <div className="controls">
        <button className="btn primary" disabled={busy} onClick={run}>
          {busy ? "Running…" : "▶ Run omnichain flow (p3)"}
        </button>
        <span className="muted" style={{ alignSelf: "center", fontSize: 12 }}>
          Casper-rooted, chain-executed · policy key {snapshot.policyPublicKey?.slice(0, 16)}…
        </span>
      </div>

      <div className="card wide">
        <h3>Address bindings (CAID ↔ external chains)</h3>
        <table className="table">
          <thead><tr><th>Agent</th><th>Chain</th><th>External address</th><th>Status</th></tr></thead>
          <tbody>
            {bindings.length === 0 && <tr><td colSpan={4} className="muted">No bindings yet — run the omnichain flow.</td></tr>}
            {bindings.map((b, i) => (
              <tr key={i}>
                <td>{b.agent_id}</td>
                <td><span className="chip">{b.external_chain}</span></td>
                <td><code>{b.external_address.slice(0, 14)}…</code></td>
                <td><span className={`chip ${b.revoked_at ? "bad" : "ok"}`}>{b.revoked_at ? "revoked" : "active"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>External receipts anchored to Casper</h3>
        <table className="table">
          <thead><tr><th>Origin</th><th>Seller</th><th>Amount</th><th>Service</th><th>Status</th></tr></thead>
          <tbody>
            {ext.length === 0 && <tr><td colSpan={5} className="muted">No external receipts.</td></tr>}
            {ext.map((r) => (
              <tr key={r.receipt_id}>
                <td><span className="chip">{r.origin_chain}</span></td>
                <td>{r.seller_agent_id}</td>
                <td>{r.amount} {r.asset}</td>
                <td className="muted">{r.service_type}</td>
                <td><span className="chip ok">{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>Global exposure (the multichain over-borrow guard)</h3>
        <table className="table">
          <thead><tr><th>Agent</th><th>Outstanding</th><th>Reserved</th><th>Max allowed</th><th>Status</th></tr></thead>
          <tbody>
            {exposure.length === 0 && <tr><td colSpan={5} className="muted">No exposure tracked.</td></tr>}
            {exposure.map((e) => (
              <tr key={e.agent_id}>
                <td>{e.agent_id}</td>
                <td>{usd(e.outstanding)}</td>
                <td>{usd(e.reserved)}</td>
                <td>{usd(e.max_allowed)}</td>
                <td><span className={`chip ${e.frozen ? "bad" : "ok"}`}>{e.frozen ? "frozen" : "active"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>Credit Authorization Notes (Casper-signed)</h3>
        <table className="table">
          <thead><tr><th>Note</th><th>Agent</th><th>Target chain</th><th>Max draw</th><th>Status</th></tr></thead>
          <tbody>
            {cans.length === 0 && <tr><td colSpan={5} className="muted">No CANs issued.</td></tr>}
            {cans.map((c) => (
              <tr key={c.note.note_id}>
                <td><code>{c.note.note_id.slice(0, 16)}…</code></td>
                <td>{c.note.agent_id}</td>
                <td><span className="chip">{c.note.target_chain}</span></td>
                <td>{usd(c.note.max_draw)} {c.note.asset}</td>
                <td><span className={`chip ${c.status === "consumed" ? "ok" : c.status === "revoked" ? "bad" : "warn"}`}>{c.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>Casper contract suite ({snapshot.contractVersions?.length ?? 0})</h3>
        <div className="caps">
          {(snapshot.contractVersions ?? []).map((c) => (
            <span key={c.name} className="chip" title={c.package_hash}>{c.name} v{c.version}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

void fmtTime;
