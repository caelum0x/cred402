/**
 * `economics` command group: pool fee schedule + health metrics.
 */
import { type CommandContext, emit, UsageError } from "../lib/context.js";
import { color, formatBps, formatCspr, formatRatio, heading, keyValues } from "../lib/render.js";

interface Economics {
  fees: {
    facilitator_fee_bps: number;
    origination_fee_bps: number;
    interest_spread_bps: number;
    late_fee_bps: number;
  };
  health: {
    utilization: number;
    realized_apy: number;
    realized_yield: string;
    loss_rate: number;
    risk_flags: string[];
  };
}

const USAGE = `economics — protocol fee schedule and pool health

Usage:
  cred402 economics show`;

export async function economicsCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "show":
    case undefined:
      return show(ctx);
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: economics ${sub}\n\n${USAGE}`);
  }
}

async function show(ctx: CommandContext): Promise<void> {
  const e = await ctx.client.get<Economics>("/api/economics");
  emit(ctx, e, () => {
    const fees = keyValues([
      ["facilitator_fee", formatBps(e.fees.facilitator_fee_bps)],
      ["origination_fee", formatBps(e.fees.origination_fee_bps)],
      ["interest_spread", formatBps(e.fees.interest_spread_bps)],
      ["late_fee", formatBps(e.fees.late_fee_bps)],
    ]);
    const health = keyValues([
      ["utilization", formatRatio(e.health.utilization)],
      ["realized_apy", formatRatio(e.health.realized_apy)],
      ["realized_yield", formatCspr(e.health.realized_yield)],
      ["loss_rate", formatRatio(e.health.loss_rate)],
      [
        "risk_flags",
        e.health.risk_flags.length ? e.health.risk_flags.map((f) => color.yellow(f)).join("\n            ") : color.green("none"),
      ],
    ]);
    return heading("Fee Schedule") + "\n" + fees + heading("Pool Health") + "\n" + health;
  });
}
