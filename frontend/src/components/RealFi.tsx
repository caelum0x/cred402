import { useState } from "react";
import type { Snapshot } from "../types";

/**
 * RealFi tab (p6) — fiat finance brought into the agent economy with ZERO PII
 * on-chain. Run the bridge to verify the operator via Stripe Identity, record
 * settled Stripe billing + Plaid cashflow, and watch the credit line lift within
 * the Casper-native cap.
 */
export function RealFi({ snapshot, onChange }: { snapshot: Snapshot; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const post = async (path: string) => {
    setBusy(true);
    try {
      await fetch(path, { method: "POST" });
      await onChange();
    } finally {
      setBusy(false);
    }
  };

  const fiat = snapshot.fiatReceipts ?? [];
  const operators = snapshot.operatorVerifications ?? [];
  const attestations = snapshot.realfiAttestations ?? [];

  return (
    <div className="pool">
      <div className="controls">
        <button className="btn primary" disabled={busy} onClick={() => post("/api/demo/realfi")}>
          {busy ? "Running…" : "▶ Run RealFi flow (p6)"}
        </button>
        <span className="muted" style={{ alignSelf: "center", fontSize: 12 }}>
          Stripe billing + Stripe Identity + Plaid · hashes only, no PII on-chain
        </span>
      </div>

      <div className="card wide">
        <h3>Operator verifications (Stripe Identity)</h3>
        <table className="table">
          <thead><tr><th>Operator</th><th>Provider</th><th>Level</th><th>Jurisdiction</th><th>Status</th></tr></thead>
          <tbody>
            {operators.length === 0 && <tr><td colSpan={5} className="muted">No verified operators — run the RealFi flow.</td></tr>}
            {operators.map((o) => (
              <tr key={o.operator_id}>
                <td><code>{o.operator_id}</code></td>
                <td className="muted">{o.provider}</td>
                <td><span className="chip">{o.verification_level}</span></td>
                <td>{o.jurisdiction}</td>
                <td><span className={`chip ${o.status === "verified" ? "ok" : o.status === "revoked" ? "bad" : "warn"}`}>{o.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>Fiat receipts (Stripe — privacy-preserving)</h3>
        <table className="table">
          <thead><tr><th>Provider</th><th>Seller</th><th>Amount</th><th>Service</th><th>Status</th></tr></thead>
          <tbody>
            {fiat.length === 0 && <tr><td colSpan={5} className="muted">No fiat receipts.</td></tr>}
            {fiat.map((r) => (
              <tr key={r.receipt_id}>
                <td><span className="chip">{r.provider}</span></td>
                <td>{r.seller_agent}</td>
                <td>{r.amount} {r.currency}</td>
                <td className="muted">{r.service_type}</td>
                <td><span className={`chip ${r.status === "disputed" ? "bad" : "ok"}`}>{r.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card wide">
        <h3>RealFi attestations (Plaid / chargebacks / sanctions)</h3>
        <table className="table">
          <thead><tr><th>Type</th><th>Subject</th><th>Provider</th><th>Status</th></tr></thead>
          <tbody>
            {attestations.length === 0 && <tr><td colSpan={4} className="muted">No attestations.</td></tr>}
            {attestations.map((a) => (
              <tr key={a.attestation_id}>
                <td><span className={`chip ${a.attestation_type === "chargeback_signal" ? "bad" : "ok"}`}>{a.attestation_type}</span></td>
                <td><code>{a.subject_id}</code></td>
                <td className="muted">{a.provider}</td>
                <td><span className={`chip ${a.status === "revoked" ? "bad" : "ok"}`}>{a.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
