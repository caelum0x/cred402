/**
 * `demo` command group: run the honest loop, the RealFi flow, or reset state.
 */
import { type CommandContext, emit, UsageError } from "../lib/context.js";
import { color, heading, sym } from "../lib/render.js";

interface StepLog {
  scene: string;
  lines: string[];
}

const USAGE = `demo — run the protocol demo scenarios

Usage:
  cred402 demo run        full honest loop (resets, earns, underwrites, draws, repays)
  cred402 demo realfi     RealFi bridge flow (operator + fiat billing uplift)
  cred402 demo reset      reset the ledger to a clean bootstrapped state`;

export async function demoCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "run":
      return runScenes(ctx, "/api/demo/run", "Honest Loop Demo");
    case "realfi":
      return runScenes(ctx, "/api/demo/realfi", "RealFi Bridge Demo");
    case "reset":
      return reset(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: demo ${sub}\n\n${USAGE}`);
  }
}

async function runScenes(ctx: CommandContext, path: string, title: string): Promise<void> {
  const result = await ctx.client.post<{ scenes: StepLog[] }>(path);
  emit(ctx, result, () => {
    const scenes = result.scenes ?? [];
    const blocks = scenes.map((s, i) => {
      const head = `${color.bold(color.cyan(`${i + 1}. ${s.scene}`))}`;
      const lines = s.lines.map((l) => `   ${color.gray("│")} ${l}`).join("\n");
      return `${head}\n${lines}`;
    });
    return heading(title) + `\n${color.dim(`${scenes.length} scenes`)}\n\n` + blocks.join("\n\n");
  });
}

async function reset(ctx: CommandContext): Promise<void> {
  const result = await ctx.client.post<{ ok: boolean }>("/api/demo/reset");
  emit(ctx, result, () => `${sym.ok()} ledger reset to a clean bootstrapped state`);
}
