/**
 * `x402` command group: fetch an x402 402 Payment-Required challenge from a paid
 * evidence endpoint and display the X-Payment-* headers + challenge body.
 */
import { type CommandContext, emit, requireArg, UsageError } from "../lib/context.js";
import { color, formatCspr, heading, keyValues, sym } from "../lib/render.js";

interface Challenge {
  payment_id: string;
  amount_motes: string;
  network: string;
  asset: string;
  resource: string;
  service_type: string;
  seller_agent: string;
  nonce: string;
  expires_at: number;
}

const USAGE = `x402 — inspect a paid-evidence x402 challenge

Usage:
  cred402 x402 quote <evidence_type> <rwa_id>

Example:
  cred402 x402 quote energy_output SOLAR-A17`;

export async function x402Command(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "quote":
      return quote(ctx);
    case undefined:
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: x402 ${sub}\n\n${USAGE}`);
  }
}

async function quote(ctx: CommandContext): Promise<void> {
  const evidenceType = requireArg(ctx.args, 1, "evidence_type");
  const rwaId = requireArg(ctx.args, 2, "rwa_id");
  const path = `/verify/${encodeURIComponent(evidenceType)}?rwa_id=${encodeURIComponent(rwaId)}`;

  const res = await ctx.client.raw("GET", path);
  const text = await res.text();
  let parsed: { challenge?: Challenge; how_to_pay?: string; status?: string } = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON body */
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.toLowerCase().startsWith("x-payment")) headers[key] = value;
  });

  const result = { status: res.status, headers, body: parsed };
  emit(ctx, result, () => {
    if (res.status !== 402) {
      return `${sym.info()} expected HTTP 402, got ${res.status}\n${color.dim(text.slice(0, 300))}`;
    }
    const ch = parsed.challenge;
    const headerPairs = Object.entries(headers).map(([k, v]) => [k, color.cyan(v)] as const);
    const challengePairs: (readonly [string, string])[] = ch
      ? [
          ["payment_id", ch.payment_id],
          ["amount", color.bold(formatCspr(ch.amount_motes))],
          ["amount_motes", ch.amount_motes],
          ["network", ch.network],
          ["asset", ch.asset],
          ["seller_agent", ch.seller_agent],
          ["service_type", ch.service_type],
          ["nonce", ch.nonce],
          ["resource", ch.resource],
        ]
      : [];
    return (
      `${color.yellow("HTTP 402 Payment Required")}\n` +
      heading("X-Payment Headers") +
      "\n" +
      keyValues(headerPairs) +
      heading("Challenge") +
      "\n" +
      keyValues(challengePairs) +
      (parsed.how_to_pay ? `\n\n${sym.arrow()} ${color.dim(parsed.how_to_pay)}` : "")
    );
  });
}
