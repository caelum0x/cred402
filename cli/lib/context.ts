/**
 * Shared command context: the configured HTTP client, global flags, and small
 * helpers for emitting either JSON (`--json`) or human output.
 */
import { Cred402Client } from "./http.js";
import { asJson } from "./render.js";

export interface CommandContext {
  readonly client: Cred402Client;
  readonly json: boolean;
  readonly apiKey?: string;
  /** Positional arguments after the command + subcommand. */
  readonly args: readonly string[];
}

/** Print a result: raw JSON when `--json`, otherwise the human renderer output. */
export function emit(ctx: CommandContext, data: unknown, human: () => string): void {
  if (ctx.json) {
    process.stdout.write(asJson(data) + "\n");
  } else {
    process.stdout.write(human() + "\n");
  }
}

/** A usage error for a command — message is shown without a stack trace. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** Require a positional argument or throw a usage error. */
export function requireArg(args: readonly string[], index: number, name: string): string {
  const v = args[index];
  if (v === undefined || v === "") throw new UsageError(`missing required argument: <${name}>`);
  return v;
}

/** Parse a CSPR amount (decimal) into integer motes string. 1 CSPR = 1e9 motes. */
export function csprToMotes(input: string): string {
  if (!/^\d+(\.\d+)?$/.test(input)) throw new UsageError(`invalid CSPR amount: "${input}"`);
  const [whole, frac = ""] = input.split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  const motes = BigInt(whole ?? "0") * 1_000_000_000n + BigInt(fracPadded || "0");
  return motes.toString();
}
