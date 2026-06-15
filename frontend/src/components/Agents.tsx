import type { Snapshot } from "../types";
import { fmtCspr } from "../api";

export function Agents({ snapshot }: { snapshot: Snapshot }) {
  const lineByAgent = new Map(snapshot.creditLines.map((l) => [l.agent_id, l]));
  const passportByAgent = new Map((snapshot.passports ?? []).map((p) => [p.agent_id, p]));
  return (
    <div className="grid">
      {snapshot.agents.map((a) => {
        const line = lineByAgent.get(a.agent_id);
        const passport = passportByAgent.get(a.agent_id);
        return (
          <div className="card agent" key={a.agent_id}>
            <div className="card-head">
              <h3>{a.agent_id}</h3>
              <span className={`chip ${a.active ? "ok" : "bad"}`}>{a.service_type}</span>
            </div>
            <div className="meterline">
              <Meter label="Reputation" value={a.reputation_score} />
              <Meter label="Accuracy" value={a.accuracy_score} />
              <Meter label="Credit score" value={a.credit_score} accent />
            </div>
            <dl className="kv">
              <div><dt>Stake</dt><dd>{fmtCspr(a.stake)} CSPR</dd></div>
              <div><dt>Jobs</dt><dd>{a.total_jobs_completed}</dd></div>
              <div><dt>Dispute rate</dt><dd>{(a.dispute_rate * 100).toFixed(1)}%</dd></div>
              <div>
                <dt>Credit line</dt>
                <dd>
                  {line ? (
                    <span className={`chip ${line.status === "active" ? "ok" : "bad"}`}>
                      {fmtCspr(line.drawn)} / {fmtCspr(line.max_credit)} CSPR ({line.status})
                    </span>
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
            </dl>
            {passport && passport.capabilities.length > 0 && (
              <div className="caps">
                {passport.capabilities.map((c) => (
                  <span key={c} className="chip">{c}</span>
                ))}
              </div>
            )}
            {passport && passport.risk_flags.length > 0 && (
              <div className="caps">
                {passport.risk_flags.map((f) => (
                  <span key={f} className="chip bad">⚠ {f}</span>
                ))}
              </div>
            )}
            <code className="pk">{a.agent_public_key.slice(0, 22)}…</code>
          </div>
        );
      })}
    </div>
  );
}

function Meter({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className="meter">
      <div className="meter-top">
        <span>{label}</span>
        <b>{value}</b>
      </div>
      <div className="bar">
        <div className={`fill ${accent ? "accent" : ""}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}
