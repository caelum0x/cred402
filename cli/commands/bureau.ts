/**
 * `bureau` command group: the read-only credit-bureau analytics surfaces —
 * discovery, portfolio, risk alerts, yield projection, peer benchmark, readiness,
 * score trend, and credit history. Each maps to a `/v1` endpoint and renders a
 * compact human view (or raw JSON with `--json`).
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { color, formatCspr, heading, keyValues, table } from "../lib/render.js";

const USAGE = `bureau — credit-bureau analytics

Usage:
  cred402 bureau discover [service_type]      ranked agent discovery
  cred402 bureau portfolio                    pool concentration (HHI) report
  cred402 bureau alerts                       risk monitoring alerts
  cred402 bureau yield                        LP forward yield projection
  cred402 bureau benchmark <agent_id>         percentile vs service cohort
  cred402 bureau readiness <agent_id>         credit-qualification scorecard
  cred402 bureau trend <agent_id>             credit-score / reputation trend
  cred402 bureau history <agent_id>           chronological credit file
  cred402 bureau health <agent_id>            green/amber/red health badge
  cred402 bureau market                       service-category market analytics
  cred402 bureau x402                         x402 receipt-network stats
  cred402 bureau disputes                     protocol dispute statistics
  cred402 bureau config                       protocol rulebook (fees, gates, tiers)
  cred402 bureau credit-check <agent_id>      credit-as-a-service oracle check (p3)
  cred402 bureau risk-score <agent_id>        ML risk-engine v2 score (p7)
  cred402 bureau data-commons                 anonymized public credit-data snapshot (p6)
  cred402 bureau exposure [agent_id]          omnichain credit exposure / reconciliation (p5)
  cred402 bureau verticals                    service-vertical underwriting profiles (p10)`;

export async function bureauCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "discover":
      return discover(ctx);
    case "portfolio":
      return portfolio(ctx);
    case "alerts":
      return alerts(ctx);
    case "yield":
      return yieldProjection(ctx);
    case "benchmark":
      return benchmark(ctx);
    case "readiness":
      return readiness(ctx);
    case "trend":
      return trend(ctx);
    case "history":
      return history(ctx);
    case "health":
      return health(ctx);
    case "market":
      return market(ctx);
    case "x402":
      return x402(ctx);
    case "disputes":
      return disputes(ctx);
    case "config":
      return config(ctx);
    case "credit-check":
      return creditCheck(ctx);
    case "risk-score":
      return riskScore(ctx);
    case "data-commons":
      return dataCommons(ctx);
    case "exposure":
      return exposure(ctx);
    case "verticals":
      return verticals(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: bureau ${sub}\n\n${USAGE}`);
  }
}

interface DiscoveryRow {
  rank: number;
  agent_id: string;
  service_type: string;
  score: number;
  tier: string;
  reputation: number;
  fraud_score: number;
  recommended: boolean;
}

async function discover(ctx: CommandContext): Promise<void> {
  const svc = ctx.args[1];
  const path = svc ? `/v1/discovery?service_type=${encodeURIComponent(svc)}` : "/v1/discovery";
  const res = await ctx.client.get<{ count: number; results: DiscoveryRow[] }>(path);
  emit(ctx, res, () =>
    heading(`Discovery (${res.count})`) +
    "\n" +
    table(
      [{ header: "#" }, { header: "AGENT" }, { header: "SERVICE" }, { header: "SCORE", align: "right" }, { header: "TIER" }, { header: "REC" }],
      res.results.map((r) => [String(r.rank), color.bold(r.agent_id), color.dim(r.service_type), String(r.score), r.tier, r.recommended ? color.green("★") : ""]),
    ),
  );
}

async function portfolio(ctx: CommandContext): Promise<void> {
  const p = await ctx.client.get<Record<string, unknown>>("/v1/credit/portfolio");
  emit(ctx, p, () =>
    heading("Portfolio") +
    "\n" +
    keyValues([
      ["outstanding", String(p.outstanding_motes)],
      ["utilization", `${((p.utilization_bps as number) / 100).toFixed(1)}%`],
      ["HHI", `${p.hhi} (${p.concentration_band})`],
      ["active_lines", String(p.active_lines)],
      ["defaults", String(p.defaults)],
    ]),
  );
}

interface AlertRow {
  severity: string;
  code: string;
  subject: string;
  message: string;
}

async function alerts(ctx: CommandContext): Promise<void> {
  const a = await ctx.client.get<{ counts: Record<string, number>; alerts: AlertRow[] }>("/v1/risk/alerts");
  emit(ctx, a, () => {
    if (a.alerts.length === 0) return heading("Risk alerts") + "\n" + color.green("✓ no active alerts");
    return (
      heading(`Risk alerts — ${a.counts.critical} critical / ${a.counts.warning} warning`) +
      "\n" +
      a.alerts
        .map((al) => {
          const sev = al.severity === "critical" ? color.red(al.severity) : al.severity === "warning" ? color.yellow(al.severity) : al.severity;
          return `  [${sev}] ${color.bold(al.code)} · ${al.subject} — ${al.message}`;
        })
        .join("\n")
    );
  });
}

interface YieldRow {
  horizon_days: number;
  net_lp_yield_motes: string;
  projected_apy: number;
}

async function yieldProjection(ctx: CommandContext): Promise<void> {
  const y = await ctx.client.get<{ weighted_avg_apr_bps: number; horizons: YieldRow[] }>("/v1/credit/yield-projection");
  emit(ctx, y, () =>
    heading(`LP yield projection — ${(y.weighted_avg_apr_bps / 100).toFixed(1)}% wavg APR`) +
    "\n" +
    table(
      [{ header: "HORIZON" }, { header: "NET LP YIELD", align: "right" }, { header: "PROJECTED APY", align: "right" }],
      y.horizons.map((h) => [`${h.horizon_days}d`, h.net_lp_yield_motes, `${(h.projected_apy * 100).toFixed(2)}%`]),
    ),
  );
}

interface Metric {
  value: number;
  cohort_median: number;
  percentile: number;
  rank: number;
}

async function benchmark(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const b = await ctx.client.get<{ cohort_size: number; service_type: string; overall_percentile: number; reputation: Metric; credit_score: Metric; fraud_score: Metric }>(
    `/v1/agents/${encodeURIComponent(id)}/benchmark`,
  );
  emit(ctx, b, () =>
    heading(`Benchmark — ${id} (${b.service_type} cohort of ${b.cohort_size})`) +
    "\n" +
    keyValues([
      ["overall_percentile", `${b.overall_percentile}th`],
      ["reputation", `${b.reputation.value} (median ${b.reputation.cohort_median}, #${b.reputation.rank}, ${b.reputation.percentile}th)`],
      ["credit_score", `${b.credit_score.value} (#${b.credit_score.rank}, ${b.credit_score.percentile}th)`],
      ["fraud_score", `${b.fraud_score.value} (#${b.fraud_score.rank}, ${b.fraud_score.percentile}th)`],
    ]),
  );
}

interface ReadinessItem {
  requirement: string;
  met: boolean;
  blocking: boolean;
  detail: string;
}

async function readiness(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const r = await ctx.client.get<{ ready: boolean; readiness_pct: number; items: ReadinessItem[] }>(`/v1/agents/${encodeURIComponent(id)}/readiness`);
  emit(ctx, r, () =>
    heading(`Readiness — ${id}: ${r.ready ? color.green("READY") : color.yellow("not ready")} (${r.readiness_pct}%)`) +
    "\n" +
    r.items
      .map((i) => `  ${i.met ? color.green("✓") : i.blocking ? color.red("✗") : color.yellow("✗")} ${color.bold(i.requirement)} — ${color.dim(i.detail)}`)
      .join("\n"),
  );
}

interface TrendSeries {
  current: number;
  change: number;
  points: { value: number }[];
}

async function trend(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const t = await ctx.client.get<{ credit_score: TrendSeries; reputation: TrendSeries }>(`/v1/agents/${encodeURIComponent(id)}/score-trend`);
  const fmt = (s: TrendSeries) => `${s.current} (${s.change >= 0 ? "+" : ""}${s.change}) [${s.points.map((p) => p.value).join("→")}]`;
  emit(ctx, t, () =>
    heading(`Score trend — ${id}`) +
    "\n" +
    keyValues([
      ["credit_score", fmt(t.credit_score)],
      ["reputation", fmt(t.reputation)],
    ]),
  );
}

interface HistoryEntry {
  seq: number;
  category: string;
  event: string;
  summary: string;
}

async function history(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const h = await ctx.client.get<{ entries: HistoryEntry[]; counts: Record<string, number> }>(`/v1/agents/${encodeURIComponent(id)}/history`);
  emit(ctx, h, () =>
    heading(`Credit file — ${id} (${h.entries.length} events)`) +
    "\n" +
    table(
      [{ header: "#" }, { header: "CATEGORY" }, { header: "EVENT" }, { header: "DETAIL" }],
      h.entries.map((e) => [String(e.seq), e.category, color.bold(e.event), color.dim(e.summary)]),
    ),
  );
}

interface HealthFactor {
  label: string;
  status: string;
  detail: string;
}

async function health(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const h = await ctx.client.get<{ status: string; score: number; factors: HealthFactor[] }>(`/v1/agents/${encodeURIComponent(id)}/health`);
  const dot = h.status === "green" ? color.green("●") : h.status === "amber" ? color.yellow("●") : color.red("●");
  emit(ctx, h, () =>
    heading(`Health — ${id}: ${dot} ${h.status} (score ${h.score})`) +
    "\n" +
    h.factors.map((f) => `  ${f.status === "green" ? color.green("✓") : f.status === "amber" ? color.yellow("•") : color.red("✗")} ${color.bold(f.label)} — ${color.dim(f.detail)}`).join("\n"),
  );
}

interface CategoryRow {
  category: string;
  agent_count: number;
  avg_reputation: number;
  total_receipts: number;
  total_revenue_motes: string;
  top_agent: string | null;
}

async function market(ctx: CommandContext): Promise<void> {
  const m = await ctx.client.get<{ categories: CategoryRow[] }>("/v1/analytics/categories");
  emit(ctx, m, () =>
    heading(`Market by category (${m.categories.length})`) +
    "\n" +
    table(
      [{ header: "CATEGORY" }, { header: "AGENTS", align: "right" }, { header: "AVG REP", align: "right" }, { header: "RECEIPTS", align: "right" }, { header: "TOP" }],
      m.categories.map((c) => [c.category, String(c.agent_count), String(c.avg_reputation), String(c.total_receipts), color.dim(c.top_agent ?? "—")]),
    ),
  );
}

interface CounterpartyRow {
  agent_id: string;
  receipts: number;
  volume_motes: string;
}

async function x402(ctx: CommandContext): Promise<void> {
  const x = await ctx.client.get<{ total_receipts: number; total_volume_motes: string; finalization_rate: number; top_sellers: CounterpartyRow[]; by_status: Record<string, number> }>("/v1/analytics/x402");
  emit(ctx, x, () =>
    heading("x402 receipt network") +
    "\n" +
    keyValues([
      ["receipts", String(x.total_receipts)],
      ["volume", formatCspr(x.total_volume_motes)],
      ["finalization", `${(x.finalization_rate * 100).toFixed(0)}%`],
      ["status", Object.entries(x.by_status).map(([s, n]) => `${s}:${n}`).join(" ")],
      ["top seller", x.top_sellers[0] ? `${x.top_sellers[0].agent_id} (${formatCspr(x.top_sellers[0].volume_motes)})` : "—"],
    ]),
  );
}

async function disputes(ctx: CommandContext): Promise<void> {
  const d = await ctx.client.get<{ total: number; open: number; resolved: number; resolution_rate: number; agent_loss_rate: number; by_verdict: Record<string, number>; total_slashed_motes: string }>("/v1/analytics/disputes");
  emit(ctx, d, () =>
    heading("Dispute statistics") +
    "\n" +
    keyValues([
      ["total", `${d.total} (${d.open} open, ${d.resolved} resolved)`],
      ["resolution_rate", `${(d.resolution_rate * 100).toFixed(0)}%`],
      ["agent_loss_rate", `${(d.agent_loss_rate * 100).toFixed(0)}%`],
      ["verdicts", Object.entries(d.by_verdict).map(([v, n]) => `${v}:${n}`).join(" ") || "—"],
      ["total_slashed", formatCspr(d.total_slashed_motes)],
    ]),
  );
}

interface TierRow {
  tier: string;
  min_reputation: number;
  credit_multiplier: number;
  origination_discount_bps: number;
}

async function config(ctx: CommandContext): Promise<void> {
  const c = await ctx.client.get<{ policy_version: string; fees: Record<string, number>; governance: Record<string, unknown>; reputation_tiers: TierRow[] }>("/v1/config");
  emit(ctx, c, () =>
    heading(`Protocol config — policy ${c.policy_version}`) +
    "\n" +
    keyValues([
      ["facilitator_fee", `${(c.fees.facilitator_fee_bps / 100).toFixed(2)}%`],
      ["origination_fee", `${(c.fees.origination_fee_bps / 100).toFixed(2)}%`],
      ["interest_spread", `${(c.fees.interest_spread_bps / 100).toFixed(0)}%`],
      ["min_reputation", String(c.governance.min_reputation_to_draw)],
      ["max_exposure", formatCspr(String(c.governance.max_agent_exposure_motes))],
    ]) +
    heading("Reputation tiers") +
    "\n" +
    table(
      [{ header: "TIER" }, { header: "MIN REP", align: "right" }, { header: "MULTIPLIER", align: "right" }, { header: "ORIG DISCOUNT", align: "right" }],
      c.reputation_tiers.map((t) => [t.tier, String(t.min_reputation), `x${t.credit_multiplier}`, `${t.origination_discount_bps}bps`]),
    ),
  );
}

async function creditCheck(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const c = await ctx.client.get<{
    exists: boolean; service_type?: string; eligible: boolean; ineligible_reason?: string;
    credit_score: number; recommended_limit_motes: string; interest_rate_bps: number; risk_flags: string[]; policy_version: string;
  }>(`/v1/credit/check/${encodeURIComponent(id)}`);
  emit(ctx, c, () =>
    heading(`Credit check — ${id}`) +
    "\n" +
    keyValues([
      ["exists", String(c.exists)],
      ["service_type", c.service_type ?? "—"],
      ["eligible", c.eligible ? color.green("yes") : color.red(`no (${c.ineligible_reason ?? "n/a"})`)],
      ["credit_score", String(c.credit_score)],
      ["recommended_limit", formatCspr(c.recommended_limit_motes)],
      ["interest_rate", `${(c.interest_rate_bps / 100).toFixed(2)}%`],
      ["risk_flags", c.risk_flags.length ? c.risk_flags.join(", ") : "none"],
      ["policy", c.policy_version],
    ]),
  );
}

async function riskScore(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const r = await ctx.client.get<{ pd: number; ml_score: number; rules_score: number; blended_score: number; risk_band: string }>(
    `/v1/agents/${encodeURIComponent(id)}/risk-score`,
  );
  emit(ctx, r, () =>
    heading(`Risk score v2 — ${id}`) +
    "\n" +
    keyValues([
      ["probability_of_default", `${(r.pd * 100).toFixed(2)}%`],
      ["ml_score", String(r.ml_score)],
      ["rules_score", String(r.rules_score)],
      ["blended_score", String(r.blended_score)],
      ["risk_band", r.risk_band],
    ]),
  );
}

async function dataCommons(ctx: CommandContext): Promise<void> {
  const d = await ctx.client.get<{
    k_anonymity: number; agents: { total: number; active: number };
    pool: { utilization_bps: number }; disputes: { total: number; resolved: number; slash_rate_bps: number };
    by_category: Array<{ family: string; agent_count: number; avg_reputation: number; outstanding_share_bps: number }>;
  }>("/v1/credit/data-commons");
  emit(ctx, d, () =>
    heading(`Credit-data commons (k=${d.k_anonymity})`) +
    "\n" +
    keyValues([
      ["agents", `${d.agents.total} (${d.agents.active} active)`],
      ["utilization", `${(d.pool.utilization_bps / 100).toFixed(1)}%`],
      ["disputes", `${d.disputes.total} (${d.disputes.resolved} resolved, ${(d.disputes.slash_rate_bps / 100).toFixed(0)}% slashed)`],
    ]) +
    heading("By category") +
    "\n" +
    table(
      [{ header: "FAMILY" }, { header: "AGENTS", align: "right" }, { header: "AVG REP", align: "right" }, { header: "OUTSTANDING SHARE", align: "right" }],
      d.by_category.map((c) => [c.family, String(c.agent_count), String(c.avg_reputation), `${(c.outstanding_share_bps / 100).toFixed(1)}%`]),
    ),
  );
}

async function exposure(ctx: CommandContext): Promise<void> {
  const id = ctx.args[1];
  if (id) {
    const e = await ctx.client.get<{
      has_exposure: boolean; consistent: boolean; casper_outstanding: string; casper_reserved: string;
      satellite_outstanding: string; max_allowed: string; global_headroom_motes: string; over_cap: boolean; frozen: boolean; alerts: string[];
    }>(`/v1/agents/${encodeURIComponent(id)}/exposure`);
    emit(ctx, e, () =>
      heading(`Exposure — ${id}`) +
      "\n" +
      keyValues([
        ["has_exposure", String(e.has_exposure)],
        ["consistent", e.consistent ? color.green("yes") : color.red("no")],
        ["casper_outstanding", e.casper_outstanding],
        ["casper_reserved", e.casper_reserved],
        ["satellite_outstanding", e.satellite_outstanding],
        ["max_allowed", e.max_allowed],
        ["global_headroom", e.global_headroom_motes],
        ["over_cap", String(e.over_cap)],
        ["frozen", String(e.frozen)],
        ["alerts", e.alerts.length ? e.alerts.join("; ") : "none"],
      ]),
    );
    return;
  }
  const all = await ctx.client.get<Array<{ agent_id: string; consistent: boolean; casper_outstanding: string; global_headroom: string; alerts: string[] }>>(
    "/v1/credit/exposure",
  );
  emit(ctx, all, () =>
    heading(`Omnichain exposure — ${all.length} agent(s)`) +
    "\n" +
    (all.length === 0
      ? color.dim("no agents with global exposure records yet")
      : table(
          [{ header: "AGENT" }, { header: "CONSISTENT" }, { header: "OUTSTANDING", align: "right" }, { header: "HEADROOM", align: "right" }, { header: "ALERTS" }],
          all.map((e) => [e.agent_id, e.consistent ? "yes" : "NO", e.casper_outstanding, e.global_headroom, String(e.alerts.length)]),
        )),
  );
}

async function verticals(ctx: CommandContext): Promise<void> {
  const list = await ctx.client.get<Array<{
    vertical: string; display_name: string; advance_rate_bps: number; revenue_volatility_bps: number;
    settlement_days: number; min_track_record_jobs: number; risk_band: string;
  }>>("/v1/verticals");
  emit(ctx, list, () =>
    heading(`Service verticals — ${list.length} profile(s)`) +
    "\n" +
    table(
      [{ header: "VERTICAL" }, { header: "ADVANCE", align: "right" }, { header: "VOLATILITY", align: "right" }, { header: "SETTLE", align: "right" }, { header: "MIN JOBS", align: "right" }, { header: "BAND" }],
      list.map((v) => [v.vertical, `${(v.advance_rate_bps / 100).toFixed(0)}%`, `${(v.revenue_volatility_bps / 100).toFixed(0)}%`, `${v.settlement_days}d`, String(v.min_track_record_jobs), v.risk_band]),
    ),
  );
}
