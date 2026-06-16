/**
 * `disputes` command group: list disputes, open a dispute against an agent.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { idempotencyKey } from "../lib/http.js";
import { color, formatCspr, formatTimestamp, heading, keyValues, statusBadge, table } from "../lib/render.js";

interface Dispute {
  dispute_id: string;
  dispute_type: string;
  complainant: string;
  respondent_agent: string;
  status: string;
  slash_amount: string;
  opened_at: number;
}

const DISPUTE_TYPES = ["bad_evidence", "fake_receipt", "non_delivery", "agent_default", "collusion"] as const;

const USAGE = `disputes — slashing disputes against agents

Usage:
  cred402 disputes list
  cred402 disputes open <respondent_agent> [dispute_type] [note]

dispute_type ∈ ${DISPUTE_TYPES.join(" | ")} (default: bad_evidence)`;

export async function disputesCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "list":
      return list(ctx);
    case "open":
      return open(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: disputes ${sub}\n\n${USAGE}`);
  }
}

async function list(ctx: CommandContext): Promise<void> {
  const disputes = await ctx.client.get<Dispute[]>("/api/disputes");
  emit(ctx, disputes, () => {
    const rows = disputes.map((d) => [
      color.bold(d.dispute_id),
      d.dispute_type,
      statusBadge(d.status),
      d.respondent_agent,
      d.complainant,
      formatCspr(d.slash_amount),
      formatTimestamp(d.opened_at),
    ]);
    return (
      heading(`Disputes (${disputes.length})`) +
      "\n" +
      table(
        [
          { header: "DISPUTE" },
          { header: "TYPE" },
          { header: "STATUS" },
          { header: "RESPONDENT" },
          { header: "COMPLAINANT" },
          { header: "SLASH", align: "right" },
          { header: "OPENED" },
        ],
        rows,
      )
    );
  });
}

async function open(ctx: CommandContext): Promise<void> {
  const respondent = requireArg(ctx.args, 1, "respondent_agent");
  const disputeType = ctx.args[2];
  const note = ctx.args[3];
  if (disputeType !== undefined && !DISPUTE_TYPES.includes(disputeType as (typeof DISPUTE_TYPES)[number])) {
    throw new UsageError(`invalid dispute_type "${disputeType}". Expected one of: ${DISPUTE_TYPES.join(", ")}`);
  }
  const body: Record<string, string> = { respondent_agent: respondent };
  if (disputeType) body["dispute_type"] = disputeType;
  if (note) body["note"] = note;

  const d = await ctx.client.post<Dispute>("/v1/disputes", body, idempotencyKey("dispute"));
  emit(ctx, d, () =>
    heading(`Opened Dispute — ${d.dispute_id}`) +
    "\n" +
    keyValues([
      ["type", d.dispute_type],
      ["status", statusBadge(d.status)],
      ["respondent", d.respondent_agent],
      ["complainant", d.complainant],
      ["opened_at", formatTimestamp(d.opened_at)],
    ]),
  );
}
