import { useEffect, useState } from "react";
import { getCreditReport, fmtCspr, type CreditReport } from "../api";

const BAND_COLOR: Record<string, string> = {
  excellent: "#3fd07a",
  very_good: "#7fd06a",
  good: "#c9d06a",
  fair: "#f5b73d",
  poor: "#ff5b5b",
};

/** Formal FICO-style credit report rendered from /api/credit-report/:id. */
export function CreditReportView({ agentId }: { agentId: string }) {
  const [r, setR] = useState<CreditReport | null>(null);

  useEffect(() => {
    getCreditReport(agentId).then(setR).catch(() => setR(null));
  }, [agentId]);

  if (!r) return <div className="muted">Generating credit report…</div>;
  if (r.error) return <div className="muted">{r.error}</div>;

  const apr = (r.recommended_terms.interest_rate_bps / 100).toFixed(1);
  return (
    <div className="credit-report">
      <div className="cr-score">
        <div className="cr-gauge" style={{ borderColor: BAND_COLOR[r.score_band] ?? "#888" }}>
          <span className="cr-num">{r.credit_score}</span>
          <span className="cr-band" style={{ color: BAND_COLOR[r.score_band] ?? "#888" }}>{r.score_band.replace("_", " ")}</span>
        </div>
        <div className="cr-terms">
          <div className="kv"><span className="muted">Default probability</span><span>{(r.pd_estimate * 100).toFixed(1)}%</span></div>
          <div className="kv"><span className="muted">Recommended line</span><span>{fmtCspr(r.recommended_terms.credit_line_motes)} CSPR</span></div>
          <div className="kv"><span className="muted">APR</span><span>{apr}%</span></div>
          <div className="kv"><span className="muted">30-day revenue</span><span>{fmtCspr(r.revenue_summary.revenue_30d_motes)} CSPR</span></div>
          <div className="kv"><span className="muted">Jobs completed</span><span>{r.revenue_summary.jobs_completed}</span></div>
        </div>
      </div>

      <div className="cr-cols">
        <div>
          <h4>Positive factors</h4>
          {r.factors.positive.map((f, i) => <div key={i} className="rowline"><span className="chip ok">+ {f.code}</span> <span className="muted">{f.detail}</span></div>)}
        </div>
        <div>
          <h4>Negative factors</h4>
          {r.factors.negative.length === 0 && <div className="muted">none</div>}
          {r.factors.negative.map((f, i) => <div key={i} className="rowline"><span className="chip bad">− {f.code}</span> <span className="muted">{f.detail}</span></div>)}
        </div>
      </div>

      <div className="cr-cols">
        <div>
          <h4>Payment history</h4>
          <div className="kv"><span className="muted">Receipts finalized</span><span>{r.payment_history.receipts_finalized}/{r.payment_history.receipts_total}</span></div>
          <div className="kv"><span className="muted">Disputed</span><span>{r.payment_history.receipts_disputed}</span></div>
          <div className="kv"><span className="muted">Repayments</span><span>{r.payment_history.repayments}</span></div>
          <div className="kv"><span className="muted">On-time rate</span><span>{(r.payment_history.on_time_rate * 100).toFixed(0)}%</span></div>
        </div>
        <div>
          <h4>Public records</h4>
          <div className="kv"><span className="muted">Disputes</span><span>{r.public_records.disputes.length}</span></div>
          <div className="kv"><span className="muted">Slashing events</span><span>{r.public_records.slashes.length}</span></div>
          <div className="kv"><span className="muted">Inquiries</span><span>{r.inquiries.length}</span></div>
          <div className="kv"><span className="muted">Compliance</span><span className={`chip ${r.compliance.cleared ? "ok" : "bad"}`}>{r.compliance.cleared ? "cleared" : "blocked"}</span></div>
        </div>
      </div>
    </div>
  );
}
