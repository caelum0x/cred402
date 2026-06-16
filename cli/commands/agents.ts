/**
 * `agents` command group: list, get, register, passport.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { idempotencyKey } from "../lib/http.js";
import { color, formatCspr, heading, keyValues, statusBadge, table, formatRatio, formatTimestamp } from "../lib/render.js";

interface Agent {
  agent_id: string;
  service_type: string;
  stake: string;
  total_jobs_completed: number;
  accuracy_score: number;
  dispute_rate: number;
  reputation_score: number;
  credit_score: number;
  active: boolean;
  registered_at: number;
}

interface Passport {
  agent_id: string;
  service_type: string;
  operator: string;
  stake: string;
  reputation_score: number;
  credit_score: number;
  credit_limit: string;
  outstanding_debt: string;
  total_receipts: number;
  total_revenue: string;
  dispute_rate: number;
  capabilities: string[];
  spending_limit: string;
  last_active_at: number;
  risk_flags: string[];
}

const USAGE = `agents — autonomous RWA agent registry

Usage:
  cred402 agents list
  cred402 agents get <agent_id>
  cred402 agents register <agent_id> <service_type>
  cred402 agents passport <agent_id>

service_type ∈ solar_output_verification | weather_risk | receivable_quality
              | risk_scoring | treasury_routing | monitoring`;

export async function agentsCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "list":
      return list(ctx);
    case "get":
      return get(ctx);
    case "register":
      return register(ctx);
    case "passport":
      return passport(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: agents ${sub}\n\n${USAGE}`);
  }
}

async function list(ctx: CommandContext): Promise<void> {
  const agents = await ctx.client.get<Agent[]>("/api/agents");
  emit(ctx, agents, () => {
    const rows = agents.map((a) => [
      color.bold(a.agent_id),
      a.service_type,
      a.active ? statusBadge("active") : statusBadge("inactive"),
      String(a.reputation_score),
      String(a.credit_score),
      formatRatio(a.dispute_rate),
      formatCspr(a.stake),
    ]);
    return (
      heading(`Agents (${agents.length})`) +
      "\n" +
      table(
        [
          { header: "AGENT" },
          { header: "SERVICE" },
          { header: "STATUS" },
          { header: "REP", align: "right" },
          { header: "CREDIT", align: "right" },
          { header: "DISPUTE", align: "right" },
          { header: "STAKE", align: "right" },
        ],
        rows,
      )
    );
  });
}

async function get(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const a = await ctx.client.get<Agent>(`/v1/agents/${encodeURIComponent(id)}`);
  emit(ctx, a, () =>
    heading(`Agent ${a.agent_id}`) +
    "\n" +
    keyValues([
      ["service_type", a.service_type],
      ["status", a.active ? statusBadge("active") : statusBadge("inactive")],
      ["reputation", String(a.reputation_score)],
      ["credit_score", String(a.credit_score)],
      ["accuracy", String(a.accuracy_score)],
      ["dispute_rate", formatRatio(a.dispute_rate)],
      ["jobs_completed", String(a.total_jobs_completed)],
      ["stake", formatCspr(a.stake)],
      ["registered_at", formatTimestamp(a.registered_at)],
    ]),
  );
}

async function register(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const serviceType = requireArg(ctx.args, 2, "service_type");
  const result = await ctx.client.post<Passport>(
    "/v1/agents",
    { agent_id: id, service_type: serviceType },
    idempotencyKey("register"),
  );
  emit(ctx, result, () =>
    heading(`Registered ${result.agent_id}`) +
    "\n" +
    keyValues([
      ["service_type", result.service_type],
      ["reputation", String(result.reputation_score)],
      ["credit_limit", formatCspr(result.credit_limit)],
      ["risk_flags", result.risk_flags.length ? result.risk_flags.map((f) => color.yellow(f)).join(", ") : color.green("none")],
    ]),
  );
}

async function passport(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const p = await ctx.client.get<Passport>(`/api/passport/${encodeURIComponent(id)}`);
  emit(ctx, p, () =>
    heading(`Passport — ${p.agent_id}`) +
    "\n" +
    keyValues([
      ["service_type", p.service_type],
      ["operator", p.operator],
      ["reputation", String(p.reputation_score)],
      ["credit_score", String(p.credit_score)],
      ["credit_limit", formatCspr(p.credit_limit)],
      ["outstanding_debt", formatCspr(p.outstanding_debt)],
      ["total_receipts", String(p.total_receipts)],
      ["total_revenue", formatCspr(p.total_revenue)],
      ["dispute_rate", formatRatio(p.dispute_rate)],
      ["spending_limit", formatCspr(p.spending_limit)],
      ["stake", formatCspr(p.stake)],
      ["capabilities", p.capabilities.length ? p.capabilities.join(", ") : color.dim("none")],
      ["risk_flags", p.risk_flags.length ? p.risk_flags.map((f) => color.red(f)).join(", ") : color.green("none")],
      ["last_active_at", formatTimestamp(p.last_active_at)],
    ]),
  );
}
