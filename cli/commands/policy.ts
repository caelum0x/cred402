/**
 * `policy` command group: upgrade the active risk-policy version.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { heading, keyValues, sym } from "../lib/render.js";

const USAGE = `policy — manage the active risk-policy version

Usage:
  cred402 policy upgrade <version>      e.g. v2`;

export async function policyCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "upgrade":
      return upgrade(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: policy ${sub}\n\n${USAGE}`);
  }
}

async function upgrade(ctx: CommandContext): Promise<void> {
  const version = requireArg(ctx.args, 1, "version");
  const result = await ctx.client.post<{ ok: boolean; version: string }>("/api/policy/upgrade", { version });
  emit(ctx, result, () =>
    heading("Policy Upgraded") + "\n" + keyValues([["active_version", result.version]]) + `\n\n${sym.ok()} policy is now ${result.version}`,
  );
}
