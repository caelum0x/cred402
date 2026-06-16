/**
 * `credit` command group: pool, explain, line, draw, repay, underwrite.
 */
import { type CommandContext, csprToMotes, emit, requireArg, UsageError } from "../lib/context.js";
import { idempotencyKey } from "../lib/http.js";
import {
  color,
  formatBps,
  formatCspr,
  formatRatio,
  formatTimestamp,
  heading,
  keyValues,
  type Polarity,
  reasonChip,
  statusBadge,
  table,
} from "../lib/render.js";

interface CreditLine {
  agent_id: string;
  max_credit: string;
  drawn: string;
  interest_rate_bps: number;
  origination_fee_bps: number;
  health_factor_bps: number;
  opened_at: number;
  due_timestamp: number;
  status: string;
}

interface PoolState {
  total_liquidity: string;
  outstanding_credit: string;
  interest_accrued: string;
  defaults: number;
  estimatedApy: number;
  creditLines: CreditLine[];
}

interface ReasonCode {
  code: string;
  polarity: Polarity;
  detail: string;
}

interface CreditDecision {
  policy_version: string;
  last_30_day_revenue: string;
  base_limit: string;
  stake_multiplier: number;
  dispute_penalty: number;
  accuracy_multiplier: number;
  credit_line: string;
  interest_rate_bps: number;
  credit_score: number;
  rationale: string[];
  reason_codes: ReasonCode[];
}

const USAGE = `credit — credit pool, underwriting, and lines

Usage:
  cred402 credit pool
  cred402 credit explain <agent_id>
  cred402 credit underwrite <agent_id>       open/refresh a credit line
  cred402 credit line <agent_id>             show a single credit line
  cred402 credit draw <agent_id> <cspr>      draw funds (CSPR)
  cred402 credit repay <agent_id> <cspr>     repay funds (CSPR)
  cred402 credit simulate <revenue_cspr> [reputation] [stake_cspr]
                                             what-if underwriting preview (read-only)
  cred402 credit offer <agent_id>            issue a pre-approval offer
  cred402 credit offers [agent_id]           list pre-approval offers
  cred402 credit accept <offer_id>           accept an offer (opens a line)
  cred402 credit decline <offer_id>          decline an offer`;

export async function creditCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "pool":
      return pool(ctx);
    case "explain":
      return explain(ctx);
    case "underwrite":
      return underwrite(ctx);
    case "line":
      return line(ctx);
    case "draw":
      return move(ctx, "draw");
    case "repay":
      return move(ctx, "repay");
    case "simulate":
      return simulate(ctx);
    case "offer":
      return issueOffer(ctx);
    case "offers":
      return listOffers(ctx);
    case "accept":
      return decideOffer(ctx, "accept");
    case "decline":
      return decideOffer(ctx, "decline");
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: credit ${sub}\n\n${USAGE}`);
  }
}

async function pool(ctx: CommandContext): Promise<void> {
  const p = await ctx.client.get<PoolState>("/api/pool");
  emit(ctx, p, () => {
    const summary = keyValues([
      ["total_liquidity", formatCspr(p.total_liquidity)],
      ["outstanding_credit", formatCspr(p.outstanding_credit)],
      ["interest_accrued", formatCspr(p.interest_accrued)],
      ["defaults", String(p.defaults)],
      ["estimated_apy", formatRatio(p.estimatedApy)],
    ]);
    const rows = p.creditLines.map((l) => [
      color.bold(l.agent_id),
      statusBadge(l.status),
      formatCspr(l.max_credit),
      formatCspr(l.drawn),
      formatBps(l.interest_rate_bps),
      formatBps(l.health_factor_bps),
      formatTimestamp(l.due_timestamp),
    ]);
    return (
      heading("Credit Pool") +
      "\n" +
      summary +
      heading(`Open Lines (${p.creditLines.length})`) +
      "\n" +
      table(
        [
          { header: "AGENT" },
          { header: "STATUS" },
          { header: "MAX", align: "right" },
          { header: "DRAWN", align: "right" },
          { header: "APR", align: "right" },
          { header: "HEALTH", align: "right" },
          { header: "DUE" },
        ],
        rows,
      )
    );
  });
}

function renderDecision(d: CreditDecision): string {
  const summary = keyValues([
    ["policy_version", d.policy_version],
    ["credit_line", color.bold(color.green(formatCspr(d.credit_line)))],
    ["credit_score", String(d.credit_score)],
    ["interest_rate", formatBps(d.interest_rate_bps)],
    ["30d_revenue", formatCspr(d.last_30_day_revenue)],
    ["base_limit", formatCspr(d.base_limit)],
    ["stake_multiplier", `x${d.stake_multiplier.toFixed(2)}`],
    ["dispute_penalty", `x${d.dispute_penalty.toFixed(3)}`],
    ["accuracy_multiplier", `x${d.accuracy_multiplier.toFixed(2)}`],
  ]);
  const chips = d.reason_codes.map((r) => reasonChip(r.code, r.polarity)).join("  ");
  const codeRows = d.reason_codes.map((r) => [reasonChip(r.code, r.polarity), color.dim(r.detail)]);
  const rationale = d.rationale.map((r) => `  ${color.gray("•")} ${r}`).join("\n");
  return (
    summary +
    heading("Reason Codes") +
    "\n" +
    chips +
    "\n\n" +
    table([{ header: "CODE" }, { header: "DETAIL" }], codeRows) +
    heading("Rationale") +
    "\n" +
    rationale
  );
}

async function explain(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const result = await ctx.client.get<{ decision: CreditDecision }>(`/api/credit/explain/${encodeURIComponent(id)}`);
  emit(ctx, result, () => heading(`Credit Explain — ${id}`) + "\n" + renderDecision(result.decision));
}

async function underwrite(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const result = await ctx.client.post<{ decision: CreditDecision; line: CreditLine }>(
    "/v1/credit/lines",
    { agent_id: id },
    idempotencyKey("underwrite"),
  );
  emit(ctx, result, () => {
    const lineInfo = keyValues([
      ["status", statusBadge(result.line.status)],
      ["max_credit", formatCspr(result.line.max_credit)],
      ["drawn", formatCspr(result.line.drawn)],
      ["due", formatTimestamp(result.line.due_timestamp)],
    ]);
    return (
      heading(`Underwrote ${id}`) +
      "\n" +
      renderDecision(result.decision) +
      heading("Credit Line") +
      "\n" +
      lineInfo
    );
  });
}

async function line(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const l = await ctx.client.get<CreditLine>(`/v1/agents/${encodeURIComponent(id)}/credit-line`);
  emit(ctx, l, () =>
    heading(`Credit Line — ${l.agent_id}`) +
    "\n" +
    keyValues([
      ["status", statusBadge(l.status)],
      ["max_credit", formatCspr(l.max_credit)],
      ["drawn", formatCspr(l.drawn)],
      ["available", formatCspr(BigInt(l.max_credit) - BigInt(l.drawn))],
      ["interest_rate", formatBps(l.interest_rate_bps)],
      ["origination_fee", formatBps(l.origination_fee_bps)],
      ["health_factor", formatBps(l.health_factor_bps)],
      ["opened_at", formatTimestamp(l.opened_at)],
      ["due", formatTimestamp(l.due_timestamp)],
    ]),
  );
}

interface SimulationResult {
  decision: CreditDecision;
  estimated_credit_line_cspr: number;
  governance_capped: boolean;
  eligible: boolean;
  ineligible_reason?: string;
}

async function simulate(ctx: CommandContext): Promise<void> {
  const revenue = requireArg(ctx.args, 1, "revenue_cspr");
  if (!/^\d+(\.\d+)?$/.test(revenue)) throw new UsageError(`invalid CSPR amount: "${revenue}"`);
  const body: Record<string, number> = { monthly_revenue_cspr: Number(revenue) };
  const reputation = ctx.args[2];
  const stake = ctx.args[3];
  if (reputation !== undefined) body.reputation = Number(reputation);
  if (stake !== undefined) body.stake_cspr = Number(stake);

  const r = await ctx.client.post<SimulationResult>("/v1/credit/simulate", body);
  emit(ctx, r, () =>
    heading("Credit Simulation (what-if)") +
    "\n" +
    keyValues([
      ["estimated_line", color.bold(color.green(`${r.estimated_credit_line_cspr} CSPR`))],
      ["credit_score", String(r.decision.credit_score)],
      ["interest_rate", formatBps(r.decision.interest_rate_bps)],
      ["eligible", r.eligible ? color.green("yes") : color.red(`no — ${r.ineligible_reason ?? ""}`)],
      ["governance_capped", r.governance_capped ? "yes" : "no"],
    ]) +
    (r.decision.reason_codes.length ? heading("Reason Codes") + "\n" + r.decision.reason_codes.map((c) => reasonChip(c.code, c.polarity)).join("  ") : ""),
  );
}

interface CreditOffer {
  offer_id: string;
  agent_id: string;
  max_credit_motes: string;
  interest_rate_bps: number;
  credit_score: number;
  status: string;
  expires_at: number;
}

async function issueOffer(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const r = await ctx.client.post<CreditOffer | { error: string }>("/v1/credit/offers", { agent_id: id }, idempotencyKey("offer"));
  emit(ctx, r, () => {
    if ("error" in r) return `${color.red("✗")} ${r.error}`;
    return (
      heading(`Pre-approval offer — ${r.agent_id}`) +
      "\n" +
      keyValues([
        ["offer_id", color.bold(r.offer_id)],
        ["max_credit", formatCspr(r.max_credit_motes)],
        ["interest_rate", formatBps(r.interest_rate_bps)],
        ["credit_score", String(r.credit_score)],
        ["status", statusBadge(r.status)],
        ["expires_at", formatTimestamp(r.expires_at)],
      ])
    );
  });
}

async function listOffers(ctx: CommandContext): Promise<void> {
  const agentId = ctx.args[1];
  const qs = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
  const offers = await ctx.client.get<CreditOffer[]>(`/v1/credit/offers${qs}`);
  emit(ctx, offers, () =>
    heading(`Credit Offers (${offers.length})`) +
    "\n" +
    table(
      [{ header: "OFFER" }, { header: "AGENT" }, { header: "MAX", align: "right" }, { header: "APR", align: "right" }, { header: "STATUS" }],
      offers.map((o) => [color.dim(o.offer_id), color.bold(o.agent_id), formatCspr(o.max_credit_motes), formatBps(o.interest_rate_bps), statusBadge(o.status)]),
    ),
  );
}

async function decideOffer(ctx: CommandContext, action: "accept" | "decline"): Promise<void> {
  const id = requireArg(ctx.args, 1, "offer_id");
  const r = await ctx.client.post<{ offer?: CreditOffer; error?: string }>(
    `/v1/credit/offers/${encodeURIComponent(id)}/${action}`,
    {},
    idempotencyKey(action),
  );
  emit(ctx, r, () => {
    if (r.error) return `${color.red("✗")} ${r.error}`;
    return `${color.green("✓")} offer ${action}ed — ${id}`;
  });
}

async function move(ctx: CommandContext, kind: "draw" | "repay"): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const cspr = requireArg(ctx.args, 2, "cspr");
  // server expects a numeric CSPR amount (amount_cspr), not motes
  if (!/^\d+(\.\d+)?$/.test(cspr)) throw new UsageError(`invalid CSPR amount: "${cspr}"`);
  // validate it is well-formed motes too (defensive)
  csprToMotes(cspr);
  const amountCspr = Number(cspr);

  const path = `/v1/credit/lines/${encodeURIComponent(id)}/${kind}`;
  if (kind === "draw") {
    const l = await ctx.client.post<CreditLine>(path, { amount_cspr: amountCspr }, idempotencyKey("draw"));
    emit(ctx, l, () =>
      heading(`Drew ${cspr} CSPR — ${l.agent_id}`) +
      "\n" +
      keyValues([
        ["status", statusBadge(l.status)],
        ["drawn", formatCspr(l.drawn)],
        ["available", formatCspr(BigInt(l.max_credit) - BigInt(l.drawn))],
        ["health_factor", formatBps(l.health_factor_bps)],
      ]),
    );
  } else {
    const r = await ctx.client.post<{ line: CreditLine; interest: string }>(
      path,
      { amount_cspr: amountCspr },
      idempotencyKey("repay"),
    );
    emit(ctx, r, () =>
      heading(`Repaid ${cspr} CSPR — ${r.line.agent_id}`) +
      "\n" +
      keyValues([
        ["status", statusBadge(r.line.status)],
        ["drawn", formatCspr(r.line.drawn)],
        ["interest_paid", formatCspr(r.interest)],
        ["health_factor", formatBps(r.line.health_factor_bps)],
      ]),
    );
  }
}
