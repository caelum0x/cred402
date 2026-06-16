#!/usr/bin/env -S npx tsx
/**
 * cred402 — command-line client for the Cred402 protocol.
 *
 * A dependency-free TypeScript CLI (node:util parseArgs + global fetch + hand-rolled
 * ANSI) that talks to the Cred402 API. Run it with:
 *
 *   npx tsx cli/cred402.ts <command> [subcommand] [args] [flags]
 *
 * Global flags:
 *   --api <url>    API base URL (default http://localhost:4021 or $CRED402_API)
 *   --key <key>    API key (Bearer / X-Api-Key); needed for admin routes under auth
 *   --json         emit raw JSON instead of formatted output
 *   --help, -h     show help
 */
import { parseArgs } from "node:util";
import { Cred402Client, ApiClientError } from "./lib/http.js";
import { type CommandContext, UsageError } from "./lib/context.js";
import { color, sym } from "./lib/render.js";

import { agentsCommand } from "./commands/agents.js";
import { creditCommand } from "./commands/credit.js";
import { marketCommand } from "./commands/market.js";
import { economicsCommand } from "./commands/economics.js";
import { realfiCommand } from "./commands/realfi.js";
import { complianceCommand } from "./commands/compliance.js";
import { disputesCommand } from "./commands/disputes.js";
import { keysCommand } from "./commands/keys.js";
import { webhooksCommand } from "./commands/webhooks.js";
import { x402Command } from "./commands/x402.js";
import { demoCommand } from "./commands/demo.js";
import { policyCommand } from "./commands/policy.js";
import { bureauCommand } from "./commands/bureau.js";

type CommandHandler = (ctx: CommandContext) => Promise<void>;

interface CommandSpec {
  readonly handler: CommandHandler;
  readonly summary: string;
}

const COMMANDS: Record<string, CommandSpec> = {
  agents: { handler: agentsCommand, summary: "agent registry: list, get, register, passport" },
  credit: { handler: creditCommand, summary: "pool, explain, line, draw, repay, underwrite, simulate, offers" },
  bureau: { handler: bureauCommand, summary: "analytics: discover, portfolio, alerts, yield, benchmark, readiness, trend, history" },
  market: { handler: marketCommand, summary: "agent service marketplace listings" },
  economics: { handler: economicsCommand, summary: "fee schedule and pool health" },
  realfi: { handler: realfiCommand, summary: "RealFi bridge: operators + fiat receipts" },
  compliance: { handler: complianceCommand, summary: "KYB / sanctions screening" },
  disputes: { handler: disputesCommand, summary: "slashing disputes: list, open" },
  keys: { handler: keysCommand, summary: "mint scoped API keys (admin)" },
  webhooks: { handler: webhooksCommand, summary: "subscribe to protocol events (admin)" },
  x402: { handler: x402Command, summary: "inspect an x402 402 payment challenge" },
  demo: { handler: demoCommand, summary: "run demo scenarios (run, realfi, reset)" },
  policy: { handler: policyCommand, summary: "upgrade the active risk-policy version" },
};

const DEFAULT_API = process.env.CRED402_API ?? "http://localhost:4021";

function topHelp(): string {
  const rows = Object.entries(COMMANDS)
    .map(([name, spec]) => `  ${color.bold(color.cyan(name.padEnd(11)))} ${color.dim(spec.summary)}`)
    .join("\n");
  return [
    color.bold("cred402") + color.dim(" — CLI for the Cred402 protocol"),
    "",
    color.bold("Usage:"),
    "  cred402 <command> [subcommand] [args] [flags]",
    "",
    color.bold("Commands:"),
    rows,
    "",
    color.bold("Global flags:"),
    `  ${color.cyan("--api <url>")}   API base URL (default ${DEFAULT_API})`,
    `  ${color.cyan("--key <key>")}   API key for authenticated/admin routes`,
    `  ${color.cyan("--json")}        emit raw JSON instead of formatted output`,
    `  ${color.cyan("--help, -h")}    show this help (or per-command help)`,
    "",
    color.dim("Examples:"),
    color.dim("  cred402 agents list"),
    color.dim("  cred402 credit explain EvidenceSellerAgent"),
    color.dim("  cred402 credit draw EvidenceSellerAgent 5 --json"),
    color.dim("  cred402 x402 quote energy_output SOLAR-A17"),
  ].join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: false,
    options: {
      api: { type: "string" },
      key: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  const command = positionals[0];

  if (!command) {
    process.stdout.write(topHelp() + "\n");
    return 0;
  }

  const spec = COMMANDS[command];
  if (!spec) {
    process.stderr.write(`${sym.err()} unknown command: ${command}\n\n${topHelp()}\n`);
    return 2;
  }

  // `cred402 <command> --help` → forward as the subcommand sentinel for per-command usage.
  const subArgs = positionals.slice(1);
  const args = values.help && subArgs.length === 0 ? ["--help"] : subArgs;

  const apiBase = typeof values.api === "string" ? values.api : DEFAULT_API;
  const apiKey = typeof values.key === "string" ? values.key : undefined;

  const ctx: CommandContext = {
    client: new Cred402Client({ baseUrl: apiBase, apiKey }),
    json: values.json === true,
    apiKey,
    args,
  };

  await spec.handler(ctx);
  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof UsageError) {
      process.stderr.write(`${sym.err()} ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (err instanceof ApiClientError) {
      const reqId = err.requestId ? color.dim(` [request_id=${err.requestId}]`) : "";
      const codeStr = err.code ? color.dim(` (${err.code})`) : "";
      process.stderr.write(`${sym.err()} ${err.message}${codeStr}${reqId}\n`);
      process.exitCode = 1;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${sym.err()} ${message}\n`);
    process.exitCode = 1;
  });
