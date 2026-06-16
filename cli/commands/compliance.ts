/**
 * `compliance` command group: KYB / sanctions / jurisdiction screening.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { color, heading, statusBadge, table } from "../lib/render.js";

interface Check {
  name: string;
  passed: boolean;
  detail: string;
}

interface ComplianceResult {
  screen: {
    subject: string;
    cleared: boolean;
    checks: Check[];
  };
  retention: {
    dataClass: string;
    retentionDays: number;
    containsPii: boolean;
    notes: string;
  }[];
}

const USAGE = `compliance — agent KYB / sanctions screening

Usage:
  cred402 compliance check <agent_id>`;

export async function complianceCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "check":
      return check(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: compliance ${sub}\n\n${USAGE}`);
  }
}

async function check(ctx: CommandContext): Promise<void> {
  const id = requireArg(ctx.args, 1, "agent_id");
  const r = await ctx.client.get<ComplianceResult>(`/api/compliance/${encodeURIComponent(id)}`);
  emit(ctx, r, () => {
    const checkRows = r.screen.checks.map((c) => [
      c.passed ? statusBadge("passed") : statusBadge("failed"),
      c.name,
      color.dim(c.detail),
    ]);
    const retRows = r.retention.map((d) => [
      d.dataClass,
      String(d.retentionDays),
      d.containsPii ? color.yellow("yes") : color.green("no"),
      color.dim(d.notes),
    ]);
    return (
      heading(`Compliance — ${r.screen.subject}`) +
      "\n" +
      `overall: ${r.screen.cleared ? statusBadge("cleared") : statusBadge("denied")}\n\n` +
      table([{ header: "RESULT" }, { header: "CHECK" }, { header: "DETAIL" }], checkRows) +
      heading("Data Retention Policy") +
      "\n" +
      table(
        [{ header: "DATA CLASS" }, { header: "DAYS", align: "right" }, { header: "PII" }, { header: "NOTES" }],
        retRows,
      )
    );
  });
}
