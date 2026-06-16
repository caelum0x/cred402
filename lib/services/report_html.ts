import type { CreditReport } from "./credit_report.js";

/**
 * Server-rendered, shareable HTML credit report — a public, linkable agent credit
 * profile (no dashboard/SPA needed). Self-contained styling; safe-escaped.
 */

const BAND_COLOR: Record<string, string> = {
  excellent: "#3fd07a",
  very_good: "#7fd06a",
  good: "#c9d06a",
  fair: "#f5b73d",
  poor: "#ff5b5b",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function cspr(motes: string): string {
  return (Number(motes) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Optional analytics rendered alongside the report when the caller has them. */
export interface ReportExtras {
  trend?: {
    credit_score: { current: number; change: number; points: { value: number }[] };
    reputation: { current: number; change: number; points: { value: number }[] };
  };
  benchmark?: { cohort_size: number; service_type: string; overall_percentile: number };
  readiness?: { ready: boolean; readiness_pct: number };
}

/** A tiny inline SVG sparkline for a series of values (server-rendered, no JS). */
function sparkSvg(values: number[], stroke: string): string {
  if (values.length < 2) return "";
  const w = 160;
  const h = 36;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - ((v - min) / span) * h).toFixed(1)}`)
    .join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${stroke}" stroke-width="2" points="${pts}"/></svg>`;
}

export function renderCreditReportHtml(r: CreditReport, extras: ReportExtras = {}): string {
  const color = BAND_COLOR[r.score_band] ?? "#888";
  const factor = (code: string, detail: string, pos: boolean) =>
    `<li class="${pos ? "pos" : "neg"}"><b>${pos ? "+" : "−"} ${esc(code)}</b> <span>${esc(detail)}</span></li>`;
  const t = extras.trend;
  const trendBlock = t
    ? `<div class="card cols">
    <div><h3>Reputation trend</h3>${sparkSvg(t.reputation.points.map((p) => p.value), t.reputation.change >= 0 ? "#3fd07a" : "#ff5b5b")}
      <div class="kv"><span class="muted">Current</span><span>${t.reputation.current} (${t.reputation.change >= 0 ? "+" : ""}${t.reputation.change})</span></div></div>
    <div><h3>Credit-score trend</h3>${sparkSvg(t.credit_score.points.map((p) => p.value), t.credit_score.change >= 0 ? "#3fd07a" : "#ff5b5b")}
      <div class="kv"><span class="muted">Current</span><span>${t.credit_score.current} (${t.credit_score.change >= 0 ? "+" : ""}${t.credit_score.change})</span></div></div>
  </div>`
    : "";
  const b = extras.benchmark;
  const rd = extras.readiness;
  const standingBlock = b || rd
    ? `<div class="card cols">
    ${b ? `<div><h3>Peer standing</h3><div class="kv"><span class="muted">${esc(b.service_type)} cohort</span><span>${b.cohort_size} agents</span></div><div class="kv"><span class="muted">Overall percentile</span><span class="chip">${b.overall_percentile}th</span></div></div>` : "<div></div>"}
    ${rd ? `<div><h3>Credit readiness</h3><div class="kv"><span class="muted">Status</span><span class="chip">${rd.ready ? "ready" : "not ready"}</span></div><div class="kv"><span class="muted">Readiness</span><span>${rd.readiness_pct}%</span></div></div>` : "<div></div>"}
  </div>`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cred402 · ${esc(r.agent_id)} credit report</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#0b0e14;color:#e8ecf4;font:15px/1.5 ui-sans-serif,system-ui,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:760px;margin:0 auto;padding:32px 20px}
  .brand{display:flex;align-items:center;gap:10px;color:#7c8aff;font-weight:700;margin-bottom:24px}
  .card{background:#11151d;border:1px solid #2a3140;border-radius:14px;padding:18px;margin-bottom:16px}
  .top{display:flex;gap:24px;align-items:center;flex-wrap:wrap}
  .gauge{width:120px;height:120px;border:6px solid ${color};border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center}
  .gauge .n{font-size:38px;font-weight:800}
  .gauge .b{font-size:12px;text-transform:capitalize;color:${color}}
  .kv{display:flex;justify-content:space-between;gap:16px;padding:3px 0}
  .muted{color:#8a93a6}
  ul{list-style:none;padding:0;margin:0}
  li{padding:4px 0;font-size:14px}
  li.pos b{color:#3fd07a}
  li.neg b{color:#ff5b5b}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media(max-width:600px){.cols{grid-template-columns:1fr}}
  h2{margin:.2em 0}
  .chip{display:inline-block;padding:2px 8px;border-radius:999px;background:#1c2330;font-size:12px}
</style></head>
<body><div class="wrap">
  <div class="brand">◆ Cred402 · Agent Credit Bureau</div>
  <div class="card top">
    <div class="gauge"><span class="n">${r.credit_score}</span><span class="b">${esc(r.score_band.replace("_", " "))}</span></div>
    <div style="flex:1;min-width:240px">
      <h2>${esc(r.agent_id)}</h2>
      <div class="kv"><span class="muted">Default probability</span><span>${(r.pd_estimate * 100).toFixed(1)}%</span></div>
      <div class="kv"><span class="muted">Recommended line</span><span>${cspr(r.recommended_terms.credit_line_motes)} CSPR</span></div>
      <div class="kv"><span class="muted">APR</span><span>${(r.recommended_terms.interest_rate_bps / 100).toFixed(1)}%</span></div>
      <div class="kv"><span class="muted">30-day revenue</span><span>${cspr(r.revenue_summary.revenue_30d_motes)} CSPR</span></div>
      <div class="kv"><span class="muted">Compliance</span><span class="chip">${r.compliance.cleared ? "cleared" : "blocked"}</span></div>
    </div>
  </div>
  <div class="card cols">
    <div><h3>Positive factors</h3><ul>${r.factors.positive.map((f) => factor(f.code, f.detail, true)).join("")}</ul></div>
    <div><h3>Negative factors</h3><ul>${r.factors.negative.length ? r.factors.negative.map((f) => factor(f.code, f.detail, false)).join("") : '<li class="muted">none</li>'}</ul></div>
  </div>
  <div class="card cols">
    <div><h3>Payment history</h3>
      <div class="kv"><span class="muted">Receipts finalized</span><span>${r.payment_history.receipts_finalized}/${r.payment_history.receipts_total}</span></div>
      <div class="kv"><span class="muted">On-time rate</span><span>${(r.payment_history.on_time_rate * 100).toFixed(0)}%</span></div>
      <div class="kv"><span class="muted">Repayments</span><span>${r.payment_history.repayments}</span></div>
    </div>
    <div><h3>Public records</h3>
      <div class="kv"><span class="muted">Disputes</span><span>${r.public_records.disputes.length}</span></div>
      <div class="kv"><span class="muted">Slashing events</span><span>${r.public_records.slashes.length}</span></div>
      <div class="kv"><span class="muted">Credit inquiries</span><span>${r.inquiries.length}</span></div>
    </div>
  </div>
  ${trendBlock}
  ${standingBlock}
  <p class="muted" style="font-size:12px">Generated ${new Date(r.generated_at * 1000).toISOString()} · Casper-rooted · explainable, no black box</p>
</div></body></html>`;
}
