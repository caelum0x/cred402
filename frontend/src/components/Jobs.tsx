import type { Snapshot } from "../types";
import { fmtCspr } from "../api";

export function Jobs({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="grid">
      {snapshot.jobs.length === 0 && <div className="empty">No RWA jobs yet — run the loop.</div>}
      {snapshot.jobs.map((j) => {
        const evidence = snapshot.evidence.filter((e) => e.rwa_id === j.rwa_id);
        return (
          <div className="card" key={j.rwa_id}>
            <div className="card-head">
              <h3>{j.name}</h3>
              <span className={`chip ${statusClass(j.status)}`}>{j.status}</span>
            </div>
            <dl className="kv">
              <div><dt>Asset</dt><dd>{j.rwa_id}</dd></div>
              <div><dt>Location</dt><dd>{j.location}</dd></div>
              <div><dt>Requested loan</dt><dd>{fmtCspr(j.requested_loan, 0)} CSPR</dd></div>
              {j.risk_result && (
                <>
                  <div><dt>Max LTV</dt><dd>{(j.risk_result.recommended_max_ltv * 100).toFixed(0)}%</dd></div>
                  <div><dt>Approved</dt><dd>{fmtCspr(j.risk_result.approved_amount, 0)} CSPR</dd></div>
                </>
              )}
            </dl>
            <div className="evidence-list">
              {j.needed_evidence.map((type) => {
                const got = evidence.find((e) => e.evidence_type === type);
                return (
                  <div key={type} className={`ev-row ${got?.verified ? "verified" : got ? "pending" : "missing"}`}>
                    <span>{type}</span>
                    {got ? (
                      <code title={got.evidence_hash}>
                        {got.verified ? "✓" : "•"} {got.confidence}/100 · {got.evidence_hash.slice(0, 12)}…
                      </code>
                    ) : (
                      <span className="muted">awaiting</span>
                    )}
                  </div>
                );
              })}
            </div>
            {j.risk_result && (
              <ul className="rationale">
                {j.risk_result.rationale.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

function statusClass(s: string): string {
  if (s === "funded") return "ok";
  if (s === "rejected") return "bad";
  return "warn";
}
