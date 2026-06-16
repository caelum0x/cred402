import { useEffect, useState } from "react";
import type { Snapshot } from "../types";
import { CreditOffers } from "./CreditOffers";
import {
  fmtCspr,
  getEconomics,
  getCreditExplain,
  getLpView,
  getPortfolio,
  getYieldProjection,
  reviewCreditLine,
  depositLiquidity,
  withdrawLiquidity,
  advanceClock,
  type EconomicsView,
  type CreditExplain,
  type LpView,
  type PortfolioReport,
  type YieldProjection,
} from "../api";

export function CreditPool({ snapshot }: { snapshot: Snapshot }) {
  const { pool, creditLines, agents } = snapshot;
  const [econ, setEcon] = useState<EconomicsView | null>(null);
  const [lp, setLp] = useState<LpView | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioReport | null>(null);
  const [yieldProj, setYieldProj] = useState<YieldProjection | null>(null);
  const [explainAgent, setExplainAgent] = useState<string | null>(null);
  const [explain, setExplain] = useState<CreditExplain | null>(null);

  useEffect(() => {
    getEconomics().then(setEcon).catch(() => setEcon(null));
    getLpView().then(setLp).catch(() => setLp(null));
    getPortfolio().then(setPortfolio).catch(() => setPortfolio(null));
    getYieldProjection().then(setYieldProj).catch(() => setYieldProj(null));
  }, [creditLines.length, pool.outstanding_credit, pool.total_liquidity]);

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
        <h3>Provide liquidity</h3>
        <div className="controls">
          {[100, 500, 1000].map((amt) => (
            <button key={amt} className="btn" onClick={() => depositLiquidity(amt).then(() => location.reload())}>
              + Deposit {amt} CSPR
            </button>
          ))}
          {[100, 500].map((amt) => (
            <button key={`w${amt}`} className="btn" onClick={() => withdrawLiquidity(amt).then((r) => (r.error ? alert(r.error) : location.reload()))}>
              − Withdraw {amt} CSPR
            </button>
          ))}
          <button className="btn" onClick={() => advanceClock(30).then(() => location.reload())} title="Advance the protocol clock to accrue interest">⏩ Advance 30 days</button>
          <span className="muted" style={{ alignSelf: "center" }}>LPs earn yield from agent interest + fees.</span>
        </div>
      </div>

      <div className="card wide">
        <h3>Utilization</h3>
        <div className="bar big">
          <div className="fill accent" style={{ width: `${Math.min(100, utilization)}%` }} />
        </div>
        <p className="muted">{utilization.toFixed(1)}% of pooled liquidity is financing agent work.</p>
      </div>

      <CreditOffers snapshot={snapshot} />

      <div className="card wide">
        <h3>Credit lines</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Agent</th><th>Drawn</th><th>Max</th><th>APR</th><th>Status</th><th></th>
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
                <td>
                  <button
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      reviewCreditLine(l.agent_id).then((r) => {
                        if ("error" in r) alert(r.error);
                        else {
                          alert(`Review: ${r.action} — ${r.detail}`);
                          if (r.action === "increased") location.reload();
                        }
                      });
                    }}
                  >
                    Review
                  </button>
                </td>
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

      {lp && lp.positions.length > 0 && (
        <div className="card wide">
          <h3>LP positions</h3>
          <table className="table">
            <thead><tr><th>Provider</th><th>Deposited</th><th>Share</th><th>Est. yield</th></tr></thead>
            <tbody>
              {lp.positions.map((p) => (
                <tr key={p.provider}>
                  <td>{p.provider}</td>
                  <td>{fmtCspr(p.deposited_motes)} CSPR</td>
                  <td>{(p.share * 100).toFixed(1)}%</td>
                  <td>{fmtCspr(p.estimated_yield_motes, 4)} CSPR</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {yieldProj && Number(yieldProj.outstanding_motes) > 0 && (
        <div className="card wide">
          <h3>
            LP yield projection{" "}
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
              forward estimate · {(yieldProj.weighted_avg_apr_bps / 100).toFixed(1)}% wavg APR · {(yieldProj.loss_assumption * 100).toFixed(0)}% loss assumption
            </span>
          </h3>
          <table className="table">
            <thead><tr><th>Horizon</th><th>Gross interest</th><th>LP share</th><th>Expected loss</th><th>Net LP yield</th><th>Projected APY</th></tr></thead>
            <tbody>
              {yieldProj.horizons.map((h) => (
                <tr key={h.horizon_days}>
                  <td>{h.horizon_days}d</td>
                  <td>{fmtCspr(h.gross_interest_motes, 4)} CSPR</td>
                  <td>{fmtCspr(h.lp_interest_motes, 4)} CSPR</td>
                  <td>{fmtCspr(h.expected_loss_motes, 4)} CSPR</td>
                  <td>{fmtCspr(h.net_lp_yield_motes, 4)} CSPR</td>
                  <td><span className="chip ok">{(h.projected_apy * 100).toFixed(2)}%</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">Projection (assumption-driven), distinct from the realized APY above.</p>
        </div>
      )}

      {portfolio && Number(portfolio.outstanding_motes) > 0 && (
        <div className="card wide">
          <h3>
            Portfolio concentration risk{" "}
            <span className={`chip ${portfolio.concentration_band === "diversified" ? "ok" : portfolio.concentration_band === "moderate" ? "warn" : "bad"}`}>
              HHI {portfolio.hhi} · {portfolio.concentration_band}
            </span>
          </h3>
          <div className="stat-row">
            <Stat label="Utilization" value={`${(portfolio.utilization_bps / 100).toFixed(1)}%`} />
            <Stat
              label="Largest borrower"
              value={portfolio.largest_borrower ? `${(portfolio.largest_borrower.share_bps / 100).toFixed(0)}%` : "—"}
              danger={!!portfolio.largest_borrower && portfolio.largest_borrower.share_bps >= 5000}
            />
            <Stat label="Active lines" value={`${portfolio.active_lines}`} />
            <Stat label="Defaults" value={`${portfolio.defaults}`} danger={portfolio.defaults > 0} />
          </div>
          <ExposureTable title="By service type" slices={portfolio.by_service_type} />
          <ExposureTable title="By reputation tier" slices={portfolio.by_tier} />
          <ExposureTable title="By health band" slices={portfolio.by_health_band} />
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

function ExposureTable({ title, slices }: { title: string; slices: { key: string; share_bps: number; outstanding_motes: string; lines: number }[] }) {
  if (slices.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <p className="muted" style={{ margin: "4px 0" }}>{title}</p>
      {slices.map((s) => (
        <div key={s.key} className="exposure-row" style={{ display: "flex", alignItems: "center", gap: 8, margin: "3px 0" }}>
          <span style={{ width: 180, fontSize: 13 }}>{s.key}</span>
          <div className="bar" style={{ flex: 1 }}>
            <div className="fill accent" style={{ width: `${Math.min(100, s.share_bps / 100)}%` }} />
          </div>
          <span className="muted" style={{ width: 64, textAlign: "right", fontSize: 12 }}>{(s.share_bps / 100).toFixed(0)}%</span>
        </div>
      ))}
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
