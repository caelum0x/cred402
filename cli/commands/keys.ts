/**
 * `keys` command group: mint scoped API keys via the admin gateway.
 * Requires an admin-scoped key when the server runs with auth enabled
 * (pass `--key <adminKey>`); in development auth is open.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { idempotencyKey } from "../lib/http.js";
import { color, heading, keyValues, sym } from "../lib/render.js";

const SCOPES = ["read", "write", "admin"] as const;

interface ApiKey {
  id: string;
  secret: string;
  scopes: string[];
}

const USAGE = `keys — mint scoped API keys (admin)

Usage:
  cred402 keys create <name> <scope...>     scopes ∈ ${SCOPES.join(" | ")}

Note: requires an admin key when the server enforces auth: --key <adminKey>`;

export async function keysCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "create":
      return create(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: keys ${sub}\n\n${USAGE}`);
  }
}

async function create(ctx: CommandContext): Promise<void> {
  const name = requireArg(ctx.args, 1, "name");
  const scopes = ctx.args.slice(2);
  if (scopes.length === 0) throw new UsageError(`at least one scope required: ${SCOPES.join(", ")}`);
  for (const s of scopes) {
    if (!SCOPES.includes(s as (typeof SCOPES)[number])) {
      throw new UsageError(`invalid scope "${s}". Expected one of: ${SCOPES.join(", ")}`);
    }
  }

  const key = await ctx.client.post<ApiKey>(
    "/v1/admin/api-keys",
    { name, scopes },
    idempotencyKey("apikey"),
  );
  emit(ctx, key, () =>
    heading(`Created API Key — ${name}`) +
    "\n" +
    keyValues([
      ["id", key.id],
      ["scopes", key.scopes.join(", ")],
      ["secret", color.bold(color.yellow(key.secret))],
    ]) +
    `\n\n${sym.info()} ${color.dim("store the secret now — it is shown only once.")}`,
  );
}
