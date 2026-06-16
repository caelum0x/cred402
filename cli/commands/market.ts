/**
 * `market` command group: list marketplace service listings.
 */
import { type CommandContext, emit, UsageError } from "../lib/context.js";
import { color, formatBps, formatCspr, formatRatio, heading, table } from "../lib/render.js";

interface Listing {
  listing_id: string;
  agent_id: string;
  category: string;
  strategy: string;
  base_price: string;
  min_payment: string;
  margin_bps: number;
  reputation_score: number;
  dispute_rate: number;
  receipt_count: number;
  stake: string;
  supported_chains: string[];
}

const USAGE = `market — agent service marketplace

Usage:
  cred402 market list`;

export async function marketCommand(ctx: CommandContext): Promise<void> {
  const sub = ctx.args[0];
  switch (sub) {
    case "list":
    case undefined:
      return list(ctx);
    case "--help":
    case "-h":
      process.stdout.write(USAGE + "\n");
      return;
    default:
      throw new UsageError(`unknown subcommand: market ${sub}\n\n${USAGE}`);
  }
}

async function list(ctx: CommandContext): Promise<void> {
  const listings = await ctx.client.get<Listing[]>("/api/marketplace");
  emit(ctx, listings, () => {
    const rows = listings.map((l) => [
      color.bold(l.listing_id),
      l.agent_id,
      l.category,
      l.strategy,
      formatCspr(l.base_price),
      formatBps(l.margin_bps),
      String(l.reputation_score),
      formatRatio(l.dispute_rate),
      l.supported_chains.join(","),
    ]);
    return (
      heading(`Marketplace Listings (${listings.length})`) +
      "\n" +
      table(
        [
          { header: "LISTING" },
          { header: "AGENT" },
          { header: "CATEGORY" },
          { header: "STRATEGY" },
          { header: "PRICE", align: "right" },
          { header: "MARGIN", align: "right" },
          { header: "REP", align: "right" },
          { header: "DISPUTE", align: "right" },
          { header: "CHAINS" },
        ],
        rows,
      )
    );
  });
}
