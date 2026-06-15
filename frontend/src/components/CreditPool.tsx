import { useEffect, useState } from "react";
import type { Snapshot } from "../types";
import {
  fmtCspr,
  getEconomics,
  getCreditExplain,
  type EconomicsView,
  type CreditExplain,
} from "../api";

export function CreditPool({ snapshot }: { snapshot: Snapshot }) {
  const { pool, creditLines, agents } = snapshot;
  const [econ, setEcon] = useState<EconomicsView | null>(null);
  const [explainAgent, setExplainAgent] = useState<string | null>(null);
  const [explain, setExplain] = useState<CreditExplain | null>(null);

  useEffect(() => {
    getEconomics().then(setEcon).catch(() => setEcon(null));
  }, [creditLines.length, pool.outstanding_credit]);

  useEffect(() => {
    if (!explainAgent) return;
    getCreditExplain(explainAgent).then(setExplain).catch(() => setExplain(null));
  }, [explainAgent]);
  const avgScore = agents.length
    ? Math.round(agents.reduce((s, a) => s + a.credit_score, 0) / agents.length)
    : 0;
  const utilization =
    Number(pool.total_liquidity) > 0
      ? (Number(pool.outstanding_credit) / Number(pool.total_liquidity)) * 100
      : 0;

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Total liquidity" value={`${fmtCspr(pool.total_liquidity, 0)} CSPR`} />
        <Stat label="Outstanding credit" value={`${fmtCspr(pool.outstanding_credit)} CSPR`} />
        <Stat label="Interest accrued" value={`${fmtCspr(pool.interest_accrued, 4)} CSPR`} />
        <Stat label="Pool APY (sim)" value={`${(snapshot.estimatedApy * 100).toFixed(2)}%`} accent />
        <Stat label="Avg agent score" value={`${avgScore}/100`} />
        <Stat label="Defaults / slashes" value={`${pool.defaults}`} danger={pool.defaults > 0} />
      </div>

      <div className="card wide">
        <h3>Utilization</h3>
        <div className="bar big">
          <div className="fill accent" style={{ width: `${Math.min(100, utilization)}%` }} />
        </div>
        <p className="muted">{utilization.toFixed(1)}% of pooled liquidity is financing agent work.</p>
      </div>

      <div className="card wide">
        <h3>Credit lines</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th><th>Drawn</th><th>Max</th><th>APR</th><th>Status</th>
            </tr>
          </thead>
          <tbody>
            {creditLines.length === 0 && (
              <tr><td colSpan={5} className="muted">No credit lines opened yet.</td></tr>
            )}
            {creditLines.map((l) => (
              <tr key={l.agent_id} className="clickable" onClick={() => setExplainAgent(l.agent_id)}>
                <td>{l.agent_id}</td>
                <td>{fmtCspr(l.drawn)} CSPR</td>
                <td>{fmtCspr(l.max_credit)} CSPR</td>
                <td>{(l.interest_rate_bps / 100).toFixed(1)}%</td>
                <td><span className={`chip ${l.status === "active" ? "ok" : "bad"}`}>{l.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Click a line to explain its credit decision (p5 §15 reason codes).</p>
      </div>

      {explain?.decision && (
        <div className="card wide">
          <h3>
            Why {explainAgent} got {fmtCspr(explain.decision.credit_line)} CSPR
            {explain.realfi_multiplier !== undefined && explain.realfi_multiplier !== 1 && (
              <span className="muted"> · RealFi ×{explain.realfi_multiplier.toFixed(2)}</span>
            )}
          </h3>
          <div className="caps">
            {(explain.decision.reason_codes ?? []).map((c, i) => (
              <span key={i} className={`chip ${c.polarity === "positive" ? "ok" : "bad"}`} title={c.detail}>
                {c.polarity === "positive" ? "+" : "−"} {c.code}
              </span>
            ))}
          </div>
        </div>
      )}

      {econ && (
        <div className="card wide">
          <h3>Protocol economics (p4 §11)</h3>
          <div className="stat-row">
            <Stat label="Realized APY (honest)" value={`${(econ.health.realized_apy * 100).toFixed(2)}%`} accent />
            <Stat label="Utilization" value={`${(econ.health.utilization * 100).toFixed(0)}%`} />
            <Stat label="Facilitator fee" value={`${(econ.fees.facilitator_fee_bps / 100).toFixed(2)}%`} />
            <Stat label="Origination fee" value={`${(econ.fees.origination_fee_bps / 100).toFixed(2)}%`} />
            <Stat label="Interest → protocol" value={`${(econ.fees.interest_spread_bps / 100).toFixed(0)}%`} />
            <Stat label="Loss rate" value={`${(econ.health.loss_rate * 100).toFixed(2)}%`} danger={econ.health.loss_rate > 0} />
          </div>
          {econ.health.risk_flags.length > 0 && (
            <p className="muted">⚠ {econ.health.risk_flags.join(" · ")}</p>
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
