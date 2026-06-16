import { useEffect, useState } from "react";
import { fmtCspr } from "../api";

/**
 * Network page — the x402 receipt network (Product B) heartbeat: payment volume,
 * settlement status, the busiest sellers and payers, and per-service throughput.
 * Reads /v1/analytics/x402, computed from the canonical receipt ledger.
 */

interface CounterpartyVolume {
  agent_id: string;
  receipts: number;
  volume_motes: string;
}

interface X402Stats {
  total_receipts: number;
  total_volume_motes: string;
  avg_receipt_motes: string;
  by_status: Record<string, number>;
  finalization_rate: number;
  top_sellers: CounterpartyVolume[];
  top_payers: CounterpartyVolume[];
  by_service: { service_type: string; receipts: number; volume_motes: string }[];
}

export function Network() {
  const [s, setS] = useState<X402Stats | null>(null);

  useEffect(() => {
    const load = () =>
      fetch("/v1/analytics/x402")
        .then((r) => r.json())
        .then((b) => setS(b.data as X402Stats))
        .catch(() => setS(null));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (!s) return <div className="empty">Loading x402 network…</div>;

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Receipts" value={`${s.total_receipts}`} accent />
        <Stat label="Total volume" value={`${fmtCspr(s.total_volume_motes, 4)} CSPR`} />
        <Stat label="Avg receipt" value={`${fmtCspr(s.avg_receipt_motes, 4)} CSPR`} />
        <Stat label="Finalization" value={`${(s.finalization_rate * 100).toFixed(0)}%`} />
      </div>

      <div className="card wide">
        <h3>Settlement status</h3>
        <div className="caps">
          {Object.entries(s.by_status).map(([status, n]) => (
            <span key={status} className={`chip ${status === "finalized" ? "ok" : status === "disputed" ? "bad" : ""}`}>
              {status}: {n}
            </span>
          ))}
        </div>
      </div>

      <div className="card cols" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <CounterpartyTable title="Top sellers" rows={s.top_sellers} />
        <CounterpartyTable title="Top payers" rows={s.top_payers} />
      </div>

      <div className="card wide">
        <h3>Volume by service</h3>
        <table className="table">
          <thead><tr><th>Service</th><th>Receipts</th><th>Volume</th></tr></thead>
          <tbody>
            {s.by_service.map((x) => (
              <tr key={x.service_type}>
                <td>{x.service_type}</td>
                <td>{x.receipts}</td>
                <td>{fmtCspr(x.volume_motes, 4)} CSPR</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CounterpartyTable({ title, rows }: { title: string; rows: CounterpartyVolume[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <table className="table">
          <thead><tr><th>Agent</th><th>Receipts</th><th>Volume</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.agent_id}>
                <td>{r.agent_id}</td>
                <td>{r.receipts}</td>
                <td>{fmtCspr(r.volume_motes, 4)} CSPR</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
