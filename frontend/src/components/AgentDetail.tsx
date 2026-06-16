import { useEffect, useState } from "react";
import { getAgentProfile, getPeerBenchmark, getCreditHistory, getScoreTrend, getAgentHealth, fmtCspr, fmtTime, type AgentProfile, type PeerBenchmark, type CreditHistory, type ScoreTrend, type AgentHealthBadge } from "../api";
import { CreditReportView } from "./CreditReportView";
import { Sparkline } from "./Sparkline";

/**
 * Agent detail — a 360° drill-down for one agent: passport, credit decision with
 * reason codes, compliance checks, RealFi status, receipts, evidence, and a
 * reputation history. Rendered as an overlay; reads /api/agent-profile/:id.
 */
export function AgentDetail({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const [p, setP] = useState<AgentProfile | null>(null);
  const [bench, setBench] = useState<PeerBenchmark | null>(null);
  const [history, setHistory] = useState<CreditHistory | null>(null);
  const [trend, setTrend] = useState<ScoreTrend | null>(null);
  const [health, setHealth] = useState<AgentHealthBadge | null>(null);
  const [view, setView] = useState<"profile" | "report" | "history">("profile");

  useEffect(() => {
    getAgentProfile(agentId).then(setP).catch(() => setP({ error: "load failed" }));
    getAgentHealth(agentId).then((h) => setHealth("error" in h ? null : h)).catch(() => setHealth(null));
    getPeerBenchmark(agentId)
      .then((b) => setBench("error" in b ? null : b))
      .catch(() => setBench(null));
    getCreditHistory(agentId)
      .then((h) => setHistory("error" in h ? null : h))
      .catch(() => setHistory(null));
    getScoreTrend(agentId)
      .then((t) => setTrend("error" in t ? null : t))
      .catch(() => setTrend(null));
  }, [agentId]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
        <div className="overlay-head">
          <h2>
            {agentId}{" "}
            {health && (
              <span
                className={`chip ${health.status === "green" ? "ok" : health.status === "amber" ? "warn" : "bad"}`}
                title={health.factors.map((f) => `${f.label}: ${f.status} (${f.detail})`).join("\n")}
              >
                ● {health.status} · {health.score}
              </span>
            )}
          </h2>
          <div className="controls" style={{ margin: 0 }}>
            <button className={`tab ${view === "profile" ? "active" : ""}`} onClick={() => setView("profile")}>Profile</button>
            <button className={`tab ${view === "report" ? "active" : ""}`} onClick={() => setView("report")}>Credit report</button>
            <button className={`tab ${view === "history" ? "active" : ""}`} onClick={() => setView("history")}>History</button>
            <a className="tab" href={`/report/${encodeURIComponent(agentId)}`} target="_blank" rel="noreferrer" title="Public shareable report">↗ Share</a>
            <button className="btn" onClick={onClose}>✕</button>
          </div>
        </div>
        {view === "report" && <CreditReportView agentId={agentId} />}
        {view === "history" && (
          <div className="overlay-body">
            <Section title="Credit file">
              {!history ? (
                <div className="muted">No history.</div>
              ) : (
                <>
                  <div className="caps">
                    {Object.entries(history.counts).filter(([, n]) => n > 0).map(([k, n]) => (
                      <span key={k} className="chip">{k} · {n}</span>
                    ))}
                  </div>
                  <table className="table" style={{ marginTop: 8 }}>
                    <thead><tr><th>#</th><th>When</th><th>Category</th><th>Event</th><th>Detail</th></tr></thead>
                    <tbody>
                      {history.entries.map((e) => (
                        <tr key={e.seq}>
                          <td>{e.seq}</td>
                          <td className="muted">{fmtTime(e.timestamp)}</td>
                          <td><span className="chip">{e.category}</span></td>
                          <td>{e.event}</td>
                          <td className="muted">{e.summary}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </Section>
          </div>
        )}
        {view === "profile" && !p && <div className="muted">Loading…</div>}
        {view === "profile" && p?.error && <div className="muted">{p.error}</div>}
        {view === "profile" && p && !p.error && (
          <div className="overlay-body">
            <Section title="Passport">
              <KV k="Service" v={p.passport?.service_type ?? "—"} />
              {p.tier?.tier && <div className="kv"><span className="muted">Tier</span><span className={`chip ${p.tier.tier === "diamond" || p.tier.tier === "platinum" || p.tier.tier === "gold" ? "ok" : ""}`}>{p.tier.tier} (×{p.tier.credit_multiplier}, −{p.tier.origination_discount_bps}bps)</span></div>}
              <KV k="Reputation" v={`${p.passport?.reputation_score ?? "—"}/100`} />
              <KV k="Operator" v={p.realfi?.operator_id ?? "anonymous"} />
              <KV k="Capabilities" v={(p.passport?.capabilities ?? []).join(", ") || "—"} />
            </Section>

            <Section title="Credit decision">
              <KV k="Credit line" v={`${fmtCspr(p.credit_explain?.decision?.credit_line ?? "0")} CSPR`} />
              <KV k="Eligible" v={p.credit_explain?.eligible ? "yes" : `no — ${p.credit_explain?.ineligible_reason ?? ""}`} />
              {p.credit_explain?.realfi_multiplier !== undefined && p.credit_explain.realfi_multiplier !== 1 && (
                <KV k="RealFi factor" v={`×${p.credit_explain.realfi_multiplier.toFixed(2)}`} />
              )}
              <div className="caps">
                {(p.credit_explain?.decision?.reason_codes ?? []).map((c, i) => (
                  <span key={i} className={`chip ${c.polarity === "positive" ? "ok" : "bad"}`} title={c.detail}>
                    {c.polarity === "positive" ? "+" : "−"} {c.code}
                  </span>
                ))}
              </div>
            </Section>

            {trend && (trend.reputation.points.length > 1 || trend.credit_score.points.length > 1) && (
              <Section title="Score trend">
                <div className="spark-row">
                  {trend.reputation.points.length > 1 && (
                    <Sparkline
                      values={trend.reputation.points.map((p) => p.value)}
                      color={trend.reputation.change >= 0 ? "#3fd07a" : "#f56b6b"}
                      label={`Reputation ${trend.reputation.current} (${trend.reputation.change >= 0 ? "+" : ""}${trend.reputation.change})`}
                    />
                  )}
                  {trend.credit_score.points.length > 1 && (
                    <Sparkline
                      values={trend.credit_score.points.map((p) => p.value)}
                      color={trend.credit_score.change >= 0 ? "#3fd07a" : "#f56b6b"}
                      label={`Credit score ${trend.credit_score.current} (${trend.credit_score.change >= 0 ? "+" : ""}${trend.credit_score.change})`}
                    />
                  )}
                </div>
              </Section>
            )}

            {bench && bench.cohort_size > 1 && (
              <Section title={`Peer benchmark · ${bench.service_type} cohort (${bench.cohort_size})`}>
                <div className="kv"><span className="muted">Overall percentile</span><span className={`chip ${bench.overall_percentile >= 66 ? "ok" : bench.overall_percentile >= 33 ? "warn" : "bad"}`}>{bench.overall_percentile}th</span></div>
                <BenchRow label="Reputation" m={bench.reputation} />
                <BenchRow label="Credit score" m={bench.credit_score} />
                <BenchRow label="Fraud (lower better)" m={bench.fraud_score} />
              </Section>
            )}

            <Section title="Compliance">
              <KV k="Cleared" v={p.compliance?.cleared ? "yes" : "no"} />
              <div className="caps">
                {(p.compliance?.checks ?? []).map((c, i) => (
                  <span key={i} className={`chip ${c.passed ? "ok" : "bad"}`} title={c.detail}>{c.name}</span>
                ))}
              </div>
            </Section>

            <Section title={`RealFi`}>
              <KV k="Operator verified" v={p.realfi?.verified ? "yes" : "no"} />
              <KV k="Fiat receipts" v={`${p.realfi?.fiat_receipts ?? 0}`} />
            </Section>

            <Section title={`Receipts (${p.receipts?.length ?? 0})`}>
              {(p.receipts ?? []).slice(0, 8).map((r) => (
                <div key={r.receipt_id} className="rowline">
                  <code>{r.receipt_id}</code> <span className="muted">{r.service_type}</span> {fmtCspr(r.amount, 4)} CSPR
                  <span className={`chip ${r.status === "finalized" ? "ok" : ""}`}>{r.status}</span>
                </div>
              ))}
            </Section>

            <Section title={`Reputation history (${p.reputation_events?.length ?? 0})`}>
              {(p.reputation_events ?? []).map((e) => (
                <div key={e.seq} className="rowline">
                  {e.previous} → <strong>{e.current}</strong> <span className="muted">{e.reason_code ?? ""}</span>
                </div>
              ))}
            </Section>
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card wide">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

function BenchRow({ label, m }: { label: string; m: { value: number; cohort_median: number; percentile: number; rank: number } }) {
  return (
    <div className="kv">
      <span className="muted">{label}</span>
      <span>
        {m.value} <span className="muted">(median {m.cohort_median})</span>{" "}
        <span className={`chip ${m.percentile >= 66 ? "ok" : m.percentile >= 33 ? "warn" : "bad"}`}>#{m.rank} · {m.percentile}th</span>
      </span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv">
      <span className="muted">{k}</span>
      <span>{v}</span>
    </div>
  );
}
