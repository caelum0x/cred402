import { useEffect, useState } from "react";
import { getComplianceReport, type ComplianceReport } from "../api";

/**
 * Compliance page — the per-jurisdiction view a compliance officer needs:
 * KYB coverage across operators, sanctions exposure, and which agents are
 * onboarded under each operator. Reads /v1/compliance/report, computed from the
 * OperatorVerificationRegistry + sanctions lists.
 */
export function Compliance() {
  const [r, setR] = useState<ComplianceReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => {
    getComplianceReport()
      .then((rep) => {
        setR(rep);
        setErr(null);
      })
      .catch((e) => setErr(String(e)));
  };

  useEffect(load, []);

  if (err) return <div className="empty">Compliance report unavailable: {err}</div>;
  if (!r) return <div className="empty">Loading compliance report…</div>;

  const coveragePct = (r.kyb_coverage * 100).toFixed(1);
  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Operators" value={`${r.total_operators}`} accent />
        <Stat label="KYB verified" value={`${r.verified_operators}`} />
        <Stat label="KYB coverage" value={`${coveragePct}%`} danger={r.kyb_coverage < 1} />
        <Stat label="Jurisdictions" value={`${r.by_jurisdiction.length}`} />
        <Stat label="Sanctioned exposure" value={`${r.sanctioned_exposure}`} danger={r.sanctioned_exposure > 0} />
      </div>

      <div className="card wide">
        <h3>
          By jurisdiction{" "}
          <button className="link-btn" onClick={load}>
            ↻ refresh
          </button>
        </h3>
        <table className="table">
          <thead>
            <tr>
              <th>Jurisdiction</th>
              <th>Operators</th>
              <th>KYB verified</th>
              <th>Status</th>
              <th>Agents onboarded</th>
            </tr>
          </thead>
          <tbody>
            {r.by_jurisdiction.map((j) => (
              <tr key={j.jurisdiction}>
                <td>{j.jurisdiction}</td>
                <td>{j.operators}</td>
                <td>
                  {j.verified}/{j.operators}
                </td>
                <td>
                  {j.sanctioned ? (
                    <span className="chip bad">SANCTIONED</span>
                  ) : j.verified === j.operators ? (
                    <span className="chip ok">clear</span>
                  ) : (
                    <span className="chip warn">partial KYB</span>
                  )}
                </td>
                <td className="muted">{j.agents.length ? j.agents.join(", ") : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
