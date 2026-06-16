import { useEffect, useState } from "react";
import { getStressTest, getCreditHealth, getLpView, simulateCredit, fmtCspr, type StressResult, type CreditHealthLine, type LpView, type SimulationResult } from "../api";

/**
 * Risk dashboard — the protocol's solvency view: a default-wave stress curve, LP
 * exposure, and per-line credit health. Answers "what happens if N% of agents
 * default" with real numbers from the live pool.
 */
export function Risk() {
  const [stress, setStress] = useState<StressResult[]>([]);
  const [health, setHealth] = useState<CreditHealthLine[]>([]);
  const [lp, setLp] = useState<LpView | null>(null);

  useEffect(() => {
    const load = () => {
      getStressTest().then(setStress).catch(() => setStress([]));
      getCreditHealth().then(setHealth).catch(() => setHealth([]));
      getLpView().then(setLp).catch(() => setLp(null));
    };
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="pool">
      {lp && (
        <div className="stat-row">
          <Stat label="Pool liquidity" value={`${fmtCspr(lp.total_liquidity_motes, 0)} CSPR`} accent />
          <Stat label="Outstanding" value={`${fmtCspr(lp.outstanding_motes)} CSPR`} />
          <Stat label="Utilization" value={`${(lp.utilization * 100).toFixed(1)}%`} />
          <Stat label="Open lines" value={`${health.length}`} />
          <Stat label="Overdue" value={`${health.filter((l) => l.overdue).length}`} danger={health.some((l) => l.overdue)} />
        </div>
      )}

      <div className="card wide">
        <h3>Default-wave stress test</h3>
        <table className="table">
          <thead><tr><th>Default rate</th><th>Net loss</th><th>Liquidity after</th><th>Coverage</th><th>Solvency</th></tr></thead>
          <tbody>
            {stress.length === 0 && <tr><td colSpan={5} className="muted">No outstanding credit to stress.</td></tr>}
            {stress.map((r) => (
              <tr key={r.default_rate}>
                <td>{(r.default_rate * 100).toFixed(0)}%</td>
                <td>{fmtCspr(r.net_loss_motes)} CSPR</td>
                <td>{fmtCspr(r.liquidity_after_motes)} CSPR</td>
                <td>{r.coverage_ratio.toFixed(3)}×</td>
                <td><span className={`chip ${r.solvent ? "ok" : "bad"}`}>{r.solvent ? "solvent" : "INSOLVENT"}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Assumes 30% recovery (slashed stake/collateral) + insurance-reserve cushion.</p>
      </div>

      <CreditSimulator />

      <div className="card wide">
        <h3>Per-line health</h3>
        <table className="table">
          <thead><tr><th>Agent</th><th>Drawn / Max</th><th>Utilization</th><th>Accrued interest</th><th>Status</th></tr></thead>
          <tbody>
            {health.length === 0 && <tr><td colSpan={5} className="muted">No credit lines.</td></tr>}
            {health.map((l) => (
              <tr key={l.agent_id}>
                <td>{l.agent_id}</td>
                <td>{fmtCspr(l.drawn_motes)} / {fmtCspr(l.max_credit_motes)} CSPR</td>
                <td>{(l.utilization * 100).toFixed(0)}%</td>
                <td>{fmtCspr((l as CreditHealthLine & { accrued_interest_motes?: string }).accrued_interest_motes ?? "0", 4)} CSPR</td>
                <td><span className={`chip ${l.status === "active" ? "ok" : "bad"}`}>{l.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A read-only "what-if" underwriting preview — runs the live risk policy against
 * hypothetical agent signals without registering anything. */
function CreditSimulator() {
  const [revenue, setRevenue] = useState("5000");
  const [stake, setStake] = useState("100");
  const [reputation, setReputation] = useState("80");
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setErr(null);
    simulateCredit({
      monthly_revenue_cspr: Number(revenue) || 0,
      stake_cspr: Number(stake) || 0,
      reputation: Number(reputation) || 0,
    })
      .then(setResult)
      .catch((e) => setErr(String(e)));
  };

  useEffect(run, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="card wide">
      <h3>Credit what-if simulator</h3>
      <div className="controls" style={{ flexWrap: "wrap", gap: 8 }}>
        <label className="muted" style={{ fontSize: 12 }}>30-day revenue (CSPR)
          <input className="input" value={revenue} onChange={(e) => setRevenue(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>Stake (CSPR)
          <input className="input" value={stake} onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <label className="muted" style={{ fontSize: 12 }}>Reputation (0–100)
          <input className="input" value={reputation} onChange={(e) => setReputation(e.target.value.replace(/[^0-9]/g, ""))} />
        </label>
        <button className="btn primary" style={{ alignSelf: "flex-end" }} onClick={run}>Simulate</button>
      </div>
      {err && <p className="muted">✗ {err}</p>}
      {result && (
        <div style={{ marginTop: 10 }}>
          <div className="stat-row">
            <Stat label="Estimated credit line" value={`${result.estimated_credit_line_cspr.toLocaleString(undefined, { maximumFractionDigits: 2 })} CSPR`} accent />
            <Stat label="Credit score" value={`${result.decision.credit_score}/100`} />
            <Stat label="APR" value={`${(result.decision.interest_rate_bps / 100).toFixed(1)}%`} />
            <Stat label="Eligible" value={result.eligible ? "yes" : "no"} danger={!result.eligible} />
          </div>
          {!result.eligible && result.ineligible_reason && <p className="muted">⚠ {result.ineligible_reason}</p>}
          {result.governance_capped && <p className="muted">Capped at the governance max-exposure ceiling.</p>}
          {result.decision.reason_codes && result.decision.reason_codes.length > 0 && (
            <div className="caps" style={{ marginTop: 6 }}>
              {result.decision.reason_codes.map((c, i) => (
                <span key={i} className={`chip ${c.polarity === "positive" ? "ok" : "bad"}`} title={c.detail}>
                  {c.polarity === "positive" ? "+" : "−"} {c.code}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
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
