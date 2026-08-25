import { useEffect, useState } from "react";
import { x402Buy, fmtCspr, type X402Trace } from "../api";
import { AlgorandX402Console } from "./AlgorandX402Console";

interface ServiceListing {
  id: string;
  name: string;
  description: string;
  price_cspr: number;
  resource: string;
  calls: number;
  revenue_motes: string;
}
interface ServiceMarketView {
  services: ServiceListing[];
  stats: { total_calls: number; total_revenue_motes: string; by_service: Record<string, number> };
}

function ServiceMarket() {
  const [view, setView] = useState<ServiceMarketView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    fetch("/api/marketplace/services")
      .then((r) => r.json())
      .then((b) => setView(b as ServiceMarketView))
      .catch(() => setView(null));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const buy = async (serviceId: string) => {
    setBusy(serviceId);
    try {
      await fetch("/api/demo/buy-service", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service_id: serviceId }) });
      await load();
    } finally {
      setBusy(null);
    }
  };

  if (!view) return null;
  return (
    <div className="card wide">
      <h3>x402 Credit-Service Marketplace — pay-per-call credit intelligence</h3>
      <div className="caps">
        <span className="chip accent">calls {view.stats.total_calls}</span>
        <span className="chip ok">revenue {fmtCspr(view.stats.total_revenue_motes, 4)} CSPR</span>
        <span className="chip">every paid call → a Cred402 x402 receipt (revenue → reputation)</span>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Service</th>
            <th>Price</th>
            <th>Calls</th>
            <th>Revenue</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {view.services.map((s) => (
            <tr key={s.id}>
              <td title={s.description}>{s.name}</td>
              <td>{s.price_cspr} CSPR</td>
              <td>{s.calls}</td>
              <td>{fmtCspr(s.revenue_motes, 4)} CSPR</td>
              <td>
                <button className="tab" disabled={busy !== null} onClick={() => buy(s.id)}>
                  {busy === s.id ? "buying…" : "buy (402→pay→200)"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * x402 playground — run the protocol's core machine-to-machine payment live:
 * an agent requests evidence, the seller replies 402 Payment Required, the buyer
 * signs a payment proof, and the seller delivers a signed report whose receipt is
 * recorded on Casper. Visualizes the real challenge headers + receipt + report.
 */
const TYPES = ["energy_output", "weather_risk", "receivable_quality"];

export function X402Playground({ agentIds }: { agentIds: readonly string[] }) {
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
      <AlgorandX402Console agentIds={agentIds} />

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

      <ServiceMarket />


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
