import type { Ledger } from "../ledger/ledger.js";

/**
 * Cred402 service marketplace (p4 §18).
 *
 * The distribution surface: agents list paid services across the full category
 * taxonomy, choose a pricing strategy, and the marketplace quotes a price for an
 * incoming request. Listings are enriched with live trust signals (reputation,
 * dispute rate, receipt count, supported chains, stake) read from the ledger, so
 * buyers pick agents on real on-chain track record, not self-reported claims.
 */

/** The full p4 §18 service-category taxonomy. */
export const SERVICE_CATEGORIES = [
  "rwa.energy_output",
  "rwa.weather_risk",
  "rwa.invoice_validity",
  "rwa.debtor_quality",
  "rwa.shipping_status",
  "rwa.warehouse_inventory",
  "rwa.insurance_check",
  "rwa.legal_document_check",
  "rwa.carbon_credit_verification",
  "rwa.payment_monitoring",
  "defi.yield_routing",
  "defi.liquidity_monitoring",
  "defi.treasury_rebalancing",
  "compliance.kyb_check",
  "compliance.sanctions_screening",
  "dispute.evidence_review",
] as const;

export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export function isServiceCategory(s: string): s is ServiceCategory {
  return (SERVICE_CATEGORIES as readonly string[]).includes(s);
}

export type PricingStrategy =
  | "fixed"
  | "dynamic"
  | "auction"
  | "subscription"
  | "reputation_tiered"
  | "urgency"
  | "data_cost_plus";

export interface ServiceListing {
  listing_id: string;
  agent_id: string;
  category: ServiceCategory;
  strategy: PricingStrategy;
  base_price: bigint; // motes
  min_payment: bigint; // motes
  /** Margin in bps over data cost (data_cost_plus) or auction reserve premium. */
  margin_bps: bigint;
  /** Subscription period in seconds (subscription strategy). */
  period_seconds: number;
}

export interface QuoteContext {
  /** Current seller load 0..1 (dynamic pricing). */
  load?: number;
  /** Urgency multiplier ≥1 (urgency pricing). */
  urgency?: number;
  /** Buyer's bids for an auction (auction pricing). */
  bids?: bigint[];
  /** Upstream data cost the seller incurs (data_cost_plus pricing). */
  data_cost?: bigint;
}

export interface Quote {
  listing_id: string;
  agent_id: string;
  category: ServiceCategory;
  strategy: PricingStrategy;
  price: bigint; // motes, never below min_payment
  breakdown: string;
}

export interface EnrichedListing extends ServiceListing {
  reputation_score: number;
  dispute_rate: number;
  receipt_count: number;
  stake: bigint;
  supported_chains: string[];
}

export class Marketplace {
  private readonly listings = new Map<string, ServiceListing>();
  private seq = 0;

  constructor(private readonly ledger: Ledger) {}

  /** List a service. The agent must be registered. */
  list(input: {
    agent_id: string;
    category: ServiceCategory;
    strategy: PricingStrategy;
    base_price: bigint;
    min_payment?: bigint;
    margin_bps?: bigint;
    period_seconds?: number;
  }): ServiceListing {
    if (!this.ledger.agents.get(input.agent_id)) throw new Error(`unknown agent: ${input.agent_id}`);
    if (!isServiceCategory(input.category)) throw new Error(`unknown service category: ${input.category}`);
    if (input.base_price <= 0n) throw new Error("base_price must be positive");
    const listing_id = `lst-${(++this.seq).toString().padStart(4, "0")}`;
    const listing: ServiceListing = {
      listing_id,
      agent_id: input.agent_id,
      category: input.category,
      strategy: input.strategy,
      base_price: input.base_price,
      min_payment: input.min_payment ?? input.base_price / 2n,
      margin_bps: input.margin_bps ?? 2000n, // 20% default margin
      period_seconds: input.period_seconds ?? 30 * 24 * 60 * 60,
    };
    this.listings.set(listing_id, listing);
    return listing;
  }

  get(listing_id: string): ServiceListing | undefined {
    return this.listings.get(listing_id);
  }

  /** Compute the price for a request against a listing's pricing strategy. */
  quote(listing_id: string, ctx: QuoteContext = {}): Quote {
    const l = this.listings.get(listing_id);
    if (!l) throw new Error(`unknown listing: ${listing_id}`);
    const { price, breakdown } = this.price(l, ctx);
    const floored = price < l.min_payment ? l.min_payment : price;
    return { listing_id, agent_id: l.agent_id, category: l.category, strategy: l.strategy, price: floored, breakdown };
  }

  private price(l: ServiceListing, ctx: QuoteContext): { price: bigint; breakdown: string } {
    switch (l.strategy) {
      case "fixed":
        return { price: l.base_price, breakdown: "fixed base price" };
      case "dynamic": {
        const load = clamp01(ctx.load ?? 0);
        const price = scale(l.base_price, 1 + load); // up to 2x at full load
        return { price, breakdown: `dynamic: base × (1 + load ${load.toFixed(2)})` };
      }
      case "urgency": {
        const urgency = Math.max(1, ctx.urgency ?? 1);
        return { price: scale(l.base_price, urgency), breakdown: `urgency × ${urgency.toFixed(2)}` };
      }
      case "auction": {
        const top = (ctx.bids ?? []).reduce((m, b) => (b > m ? b : m), 0n);
        const reserve = l.base_price + applyBps(l.base_price, l.margin_bps);
        const price = top > reserve ? top : reserve;
        return { price, breakdown: `auction: max(top bid, reserve)` };
      }
      case "subscription":
        return { price: l.base_price, breakdown: `subscription per ${l.period_seconds}s period` };
      case "reputation_tiered": {
        const rep = this.ledger.agents.get(l.agent_id)?.reputation_score ?? 50;
        // Higher-reputation sellers command a premium, bounded ±50%.
        const factor = Math.max(0.5, Math.min(1.5, 1 + (rep - 50) / 100));
        return { price: scale(l.base_price, factor), breakdown: `reputation-tiered × ${factor.toFixed(2)} (rep ${rep})` };
      }
      case "data_cost_plus": {
        const cost = ctx.data_cost ?? 0n;
        const price = cost + applyBps(cost, l.margin_bps) + l.base_price;
        return { price, breakdown: `data cost + ${Number(l.margin_bps) / 100}% margin + base` };
      }
    }
  }

  /** All listings (optionally for one category) enriched with on-chain trust signals. */
  enriched(category?: ServiceCategory): EnrichedListing[] {
    const out: EnrichedListing[] = [];
    for (const l of this.listings.values()) {
      if (category && l.category !== category) continue;
      const agent = this.ledger.agents.get(l.agent_id);
      out.push({
        ...l,
        reputation_score: agent?.reputation_score ?? 0,
        dispute_rate: agent?.dispute_rate ?? 0,
        receipt_count: this.ledger.receipts.forSeller(l.agent_id).length,
        stake: agent?.stake ?? 0n,
        supported_chains: ["casper", ...this.ledger.bindings.forAgent(l.agent_id).map((b) => b.external_chain)],
      });
    }
    // Rank by reputation, then receipt count — the marketplace surfaces proven agents first.
    return out.sort((a, b) => b.reputation_score - a.reputation_score || b.receipt_count - a.receipt_count);
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function scale(motes: bigint, factor: number): bigint {
  const scaled = Math.round(factor * 1e9);
  return (motes * BigInt(scaled)) / 1_000_000_000n;
}

function applyBps(motes: bigint, bps: bigint): bigint {
  return (motes * bps) / 10_000n;
}
