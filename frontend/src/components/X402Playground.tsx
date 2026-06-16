import { useState } from "react";
import { x402Buy, fmtCspr, type X402Trace } from "../api";

/**
 * x402 playground — run the protocol's core machine-to-machine payment live:
 * an agent requests evidence, the seller replies 402 Payment Required, the buyer
 * signs a payment proof, and the seller delivers a signed report whose receipt is
 * recorded on Casper. Visualizes the real challenge headers + receipt + report.
 */
const TYPES = ["energy_output", "weather_risk", "receivable_quality"];

export function X402Playground() {
  const [type, setType] = useState(TYPES[0]!);
  const [tampered, setTampered] = useState(false);
  const [trace, setTrace] = useState<X402Trace | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      setTrace(await x402Buy(type, tampered));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pool">
      <div className="card wide">
        <h3>x402 payment flow</h3>
        <div className="controls">
          {TYPES.map((t) => (
            <button key={t} className={`tab ${t === type ? "active" : ""}`} onClick={() => setType(t)}>{t}</button>
          ))}
          <button className={`tab ${tampered ? "active" : ""}`} onClick={() => setTampered((v) => !v)} title="Submit dishonest data">
            {tampered ? "⚠ tampered" : "honest"}
          </button>
          <button className="btn primary" disabled={busy} onClick={run}>{busy ? "Running…" : "▶ Run x402 purchase"}</button>
        </div>
      </div>

      {trace && (
        <>
          <div className="card wide">
            <h3>1 · 402 Payment Required</h3>
            <table className="table">
              <tbody>
                {Object.entries(trace.challenge_headers).map(([k, v]) => (
                  <tr key={k}><td><code>{k}</code></td><td className="muted">{v}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card wide">
            <h3>2 · Receipt recorded on Casper</h3>
            <div className="kv"><span className="muted">Receipt id</span><code>{trace.receipt.receipt_id}</code></div>
            <div className="kv"><span className="muted">Amount</span><span>{fmtCspr(trace.receipt.amount, 4)} CSPR</span></div>
            <div className="kv"><span className="muted">Status</span><span className="chip ok">{trace.receipt.status}</span></div>
            <div className="kv"><span className="muted">Result hash</span><code>{short(trace.receipt.result_hash)}</code></div>
            <div className="kv"><span className="muted">Payment proof</span><code>{short(trace.receipt.payment_proof_hash)}</code></div>
          </div>

          <div className="card wide">
            <h3>3 · Signed evidence report</h3>
            <div className="kv"><span className="muted">Evidence type</span><span>{trace.report.evidence_type}</span></div>
            <div className="kv"><span className="muted">Confidence</span><span className={`chip ${trace.report.confidence >= 60 ? "ok" : "bad"}`}>{trace.report.confidence}/100</span></div>
            <div className="kv"><span className="muted">Evidence hash</span><code>{short(trace.report.evidence_hash)}</code></div>
            {trace.report.fields && <pre className="json-out">{JSON.stringify(trace.report.fields, null, 2)}</pre>}
          </div>
        </>
      )}
    </div>
  );
}

function short(h: string): string {
  return h && h.length > 22 ? `${h.slice(0, 16)}…${h.slice(-4)}` : h;
}
