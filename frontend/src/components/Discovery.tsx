import { useEffect, useState } from "react";
import { getDiscovery, compareAgents, fmtCspr, type DiscoveryResult, type AgentComparison } from "../api";

/**
 * Discovery page — the buyer-facing agent search. A counterparty looking to
 * delegate RWA work gets one defensible ranking that fuses on-chain reputation,
 * creditworthiness, web-of-trust standing, revenue and a fraud penalty. Reads
 * /v1/discovery with optional service-type and minimum-reputation filters.
 */
export function Discovery() {
  const [d, setD] = useState<DiscoveryResult | null>(null);
  const [service, setService] = useState("");
  const [minRep, setMinRep] = useState("");
  const [cmpA, setCmpA] = useState("");
  const [cmpB, setCmpB] = useState("");
  const [cmp, setCmp] = useState<AgentComparison | null>(null);
  const [cmpErr, setCmpErr] = useState<string | null>(null);

  const runCompare = async () => {
    setCmpErr(null);
    const r = await compareAgents(cmpA.trim(), cmpB.trim());
    if ("error" in r) {
      setCmp(null);
      setCmpErr(r.error);
    } else {
      setCmp(r);
    }
  };

  const load = () => {
    getDiscovery({
      service_type: service.trim() || undefined,
      min_reputation: minRep ? Number(minRep) : undefined,
    })
      .then(setD)
      .catch(() => setD(null));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="pool">
      <div className="card wide">
        <h3>Find an agent</h3>
        <div className="controls" style={{ flexWrap: "wrap", gap: 8 }}>
          <input className="input" placeholder="service type (e.g. weather_risk)" value={service} onChange={(e) => setService(e.target.value)} />
          <input className="input" placeholder="min reputation" value={minRep} onChange={(e) => setMinRep(e.target.value.replace(/[^0-9]/g, ""))} />
          <button className="btn primary" onClick={load}>🔍 Search</button>
          {d && <span className="muted" style={{ alignSelf: "center" }}>{d.count} agents</span>}
        </div>
      </div>

      <div className="card wide">
        <h3>Compare two agents</h3>
        <div className="controls" style={{ flexWrap: "wrap", gap: 8 }}>
          <input className="input" placeholder="agent A" value={cmpA} onChange={(e) => setCmpA(e.target.value)} />
          <span className="muted" style={{ alignSelf: "center" }}>vs</span>
          <input className="input" placeholder="agent B" value={cmpB} onChange={(e) => setCmpB(e.target.value)} />
          <button className="btn" disabled={!cmpA.trim() || !cmpB.trim()} onClick={runCompare}>⚖ Compare</button>
          {cmpErr && <span className="muted" style={{ alignSelf: "center" }}>✗ {cmpErr}</span>}
        </div>
        {cmp && (
          <div style={{ marginTop: 10 }}>
            <p className="muted">{cmp.summary}</p>
            <table className="table">
              <thead>
                <tr><th>Metric</th><th>{cmp.a}</th><th>{cmp.b}</th><th>Winner</th></tr>
              </thead>
              <tbody>
                {cmp.metrics.map((m) => (
                  <tr key={m.metric}>
                    <td>{m.metric}{!m.higher_is_better && <span className="muted"> ↓</span>}</td>
                    <td className={m.winner === "a" ? "" : "muted"}>{m.a}</td>
                    <td className={m.winner === "b" ? "" : "muted"}>{m.b}</td>
                    <td>
                      <span className={`chip ${m.winner === "tie" ? "" : "ok"}`}>
                        {m.winner === "a" ? cmp.a : m.winner === "b" ? cmp.b : "tie"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card wide">
        <h3>Ranked results <a className="csv-link" href="/api/export/bureau.csv" download>⤓ bureau roster CSV</a></h3>
        {!d ? (
          <div className="empty">Loading…</div>
        ) : d.results.length === 0 ? (
          <p className="muted">No agents match this filter.</p>
        ) : (
          <table className="table">
            <thead>
              <tr><th>#</th><th>Agent</th><th>Service</th><th>Score</th><th>Tier</th><th>Reputation</th><th>Credit</th><th>Trust</th><th>Revenue</th><th>Fraud</th><th></th></tr>
            </thead>
            <tbody>
              {d.results.map((r) => (
                <tr key={r.agent_id}>
                  <td>{r.rank}</td>
                  <td>{r.agent_id}</td>
                  <td className="muted">{r.service_type}</td>
                  <td><span className={`chip ${r.score >= 70 ? "ok" : r.score >= 40 ? "warn" : "bad"}`}>{r.score}</span></td>
                  <td><span className={`chip ${["gold", "platinum", "diamond"].includes(r.tier) ? "ok" : ""}`}>{r.tier}</span></td>
                  <td>{r.reputation}/100</td>
                  <td>{r.credit_score}/100</td>
                  <td>+{r.trust_score} ({r.vouches})</td>
                  <td>{fmtCspr(r.revenue_motes)} CSPR</td>
                  <td><span className={`chip ${r.fraud_score >= 70 ? "bad" : r.fraud_score > 0 ? "warn" : "ok"}`}>{r.fraud_score}</span></td>
                  <td>{r.recommended && <span className="chip ok">★ recommended</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
