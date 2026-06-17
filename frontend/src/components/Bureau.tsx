import { useEffect, useState } from "react";
import {
  getDataCommons,
  getVerticals,
  getRiskScore,
  getCreditCheck,
  fmtCspr,
  type DataCommonsSnapshot,
  type VerticalProfile,
  type RiskScoreV2,
  type CreditCheckResult,
} from "../api";

/**
 * Bureau page — the credit-bureau intelligence surface (roadmap p3/p5/p6/p7/p10):
 * the anonymized public credit-data commons (p6), an agent risk-score + oracle
 * lookup (p7 ML risk-engine v2 + p3 credit-as-a-service), and the per-vertical
 * underwriting profiles (p10). Reads the same `/v1` endpoints exposed to external
 * x402 builders — this is "Cred402 Inside" made visible.
 */
export function Bureau() {
  const [commons, setCommons] = useState<DataCommonsSnapshot | null>(null);
  const [verticals, setVerticals] = useState<VerticalProfile[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    Promise.all([getDataCommons(), getVerticals()])
      .then(([c, v]) => {
        setCommons(c);
        setVerticals(v);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  };

  useEffect(load, []);

  if (err) return <div className="empty">Bureau data unavailable: {err}</div>;
  if (!commons) return <div className="empty">Loading credit-bureau intelligence…</div>;

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Agents" value={`${commons.agents.total}`} accent />
        <Stat label="Active" value={`${commons.agents.active}`} />
        <Stat label="Pool utilization" value={`${(commons.pool.utilization_bps / 100).toFixed(1)}%`} />
        <Stat label="Outstanding" value={fmtCspr(commons.pool.outstanding_credit_motes)} />
        <Stat
          label="Dispute slash rate"
          value={`${(commons.disputes.slash_rate_bps / 100).toFixed(0)}%`}
          danger={commons.disputes.slash_rate_bps > 0}
        />
      </div>

      <AgentLookup />

      <div className="card wide">
        <h3>
          Credit-data commons{" "}
          <span className="muted">· anonymized public good (k={commons.k_anonymity})</span>{" "}
          <button className="link-btn" onClick={load}>
            ↻ refresh
          </button>
        </h3>
        <table className="table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Agents</th>
              <th>Avg reputation</th>
              <th>Outstanding share</th>
            </tr>
          </thead>
          <tbody>
            {commons.by_category.map((c) => (
              <tr key={c.family}>
                <td>{c.family}</td>
                <td>{c.agent_count}</td>
                <td>{c.avg_reputation}</td>
                <td>{(c.outstanding_share_bps / 100).toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {commons.by_tier.length > 0 && (
          <div className="chip-row" style={{ marginTop: "0.75rem" }}>
            {commons.by_tier.map((t) => (
              <span key={t.tier} className="chip">
                {t.tier}: {t.agent_count} ({(t.share_bps / 100).toFixed(0)}%)
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card wide">
        <h3>
          Service verticals <span className="muted">· per-vertical underwriting profiles</span>
        </h3>
        <table className="table">
          <thead>
            <tr>
              <th>Vertical</th>
              <th>Advance rate</th>
              <th>Volatility haircut</th>
              <th>Settlement</th>
              <th>Min jobs</th>
              <th>Risk band</th>
            </tr>
          </thead>
          <tbody>
            {verticals.map((v) => (
              <tr key={v.vertical}>
                <td title={v.required_attestations.join(", ") || "no attestation required"}>{v.display_name}</td>
                <td>{(v.advance_rate_bps / 100).toFixed(0)}%</td>
                <td>{(v.revenue_volatility_bps / 100).toFixed(0)}%</td>
                <td>{v.settlement_days}d</td>
                <td>{v.min_track_record_jobs}</td>
                <td>
                  <BandChip band={v.risk_band} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Per-agent risk-score (p7) + oracle credit-check (p3) lookup. */
function AgentLookup() {
  const [agentId, setAgentId] = useState("");
  const [risk, setRisk] = useState<RiskScoreV2 | null>(null);
  const [check, setCheck] = useState<CreditCheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = () => {
    const id = agentId.trim();
    if (!id) return;
    setLoading(true);
    Promise.all([getRiskScore(id), getCreditCheck(id)])
      .then(([r, c]) => {
        setRisk(r);
        setCheck(c);
        setErr(null);
      })
      .catch((e) => {
        setErr(String(e));
        setRisk(null);
        setCheck(null);
      })
      .finally(() => setLoading(false));
  };

  return (
    <div className="card wide">
      <h3>
        Agent credit lookup <span className="muted">· risk-score v2 (p7) + oracle (p3)</span>
      </h3>
      <div className="form-row">
        <input
          className="input"
          placeholder="agent id (e.g. RWARequestAgent)"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <button className="btn" onClick={run} disabled={loading || !agentId.trim()}>
          {loading ? "…" : "Check"}
        </button>
      </div>
      {err && <div className="muted" style={{ marginTop: "0.5rem" }}>Lookup failed: {err}</div>}
      {risk && check && (
        <div className="stat-row" style={{ marginTop: "0.75rem" }}>
          <Stat label="Eligible" value={check.eligible ? "yes" : "no"} danger={!check.eligible} accent={check.eligible} />
          <Stat label="Blended score" value={`${risk.blended_score}`} />
          <Stat label="ML score" value={`${risk.ml_score}`} />
          <Stat label="Rules score" value={`${risk.rules_score}`} />
          <Stat label="Prob. of default" value={`${(risk.pd * 100).toFixed(2)}%`} danger={risk.pd >= 0.25} />
          <Stat label="Recommended limit" value={fmtCspr(check.recommended_limit_motes)} />
        </div>
      )}
      {risk && check && (
        <div className="chip-row" style={{ marginTop: "0.5rem" }}>
          <BandChip band={risk.risk_band} />
          {check.service_type && <span className="chip">{check.service_type}</span>}
          {!check.eligible && check.ineligible_reason && <span className="chip bad">{check.ineligible_reason}</span>}
          {check.risk_flags.map((f) => (
            <span key={f} className="chip warn">
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BandChip({ band }: { band: string }) {
  const cls = band === "low" ? "ok" : band === "high" ? "bad" : "warn";
  return <span className={`chip ${cls}`}>{band}</span>;
}

function Stat({ label, value, accent, danger }: { label: string; value: string; accent?: boolean; danger?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""} ${danger ? "danger" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
