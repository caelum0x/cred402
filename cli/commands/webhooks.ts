/**
 * `webhooks` command group: subscribe a URL to protocol events (admin).
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { idempotencyKey } from "../lib/http.js";
import { color, formatTimestamp, heading, keyValues, sym } from "../lib/render.js";

interface Webhook {
  id: string;
  url: string;
  events: string[];
  secret: string;
  created_at: number;
}

const USAGE = `webhooks — subscribe to protocol events (admin)

Usage:
  cred402 webhooks add <url> [event...]     defaults to all events (*)

Note: requires an admin key when the server enforces auth: --key <adminKey>`;

export async function webhooksCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "add":
      return add(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: webhooks ${sub}\n\n${USAGE}`);
  }
}

async function add(ctx: CommandContext): Promise<void> {
  const url = requireArg(ctx.args, 1, "url");
  if (!/^https?:\/\//.test(url)) throw new UsageError(`url must start with http:// or https://, got "${url}"`);
  const events = ctx.args.slice(2);
  const body: Record<string, unknown> = { url };
  if (events.length > 0) body["events"] = events;

  const wh = await ctx.client.post<Webhook>("/v1/webhooks", body, idempotencyKey("webhook"));
  emit(ctx, wh, () =>
    heading(`Subscribed Webhook — ${wh.id}`) +
    "\n" +
    keyValues([
      ["url", wh.url],
      ["events", wh.events.join(", ")],
      ["secret", color.bold(color.yellow(wh.secret))],
      ["created_at", formatTimestamp(wh.created_at)],
    ]) +
    `\n\n${sym.info()} ${color.dim("HMAC-sign deliveries with the secret above.")}`,
  );
}
