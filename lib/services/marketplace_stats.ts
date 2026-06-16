import type { Marketplace } from "./marketplace.js";

/**
 * Marketplace statistics — the supply side of the agent economy. The marketplace is
 * where agents advertise paid services; this aggregates the listing book into
 * category and pricing-strategy distributions, the price range, and the most active
 * sellers, so a buyer can read the market and an operator can see where supply
 * concentrates. Complements the x402 stats (which measure realized demand).
 */

export interface SellerListings {
  agent_id: string;
  listings: number;
  avg_reputation: number;
}

export interface MarketplaceStats {
  total_listings: number;
  sellers: number;
  by_category: Record<string, number>;
  by_strategy: Record<string, number>;
  price_motes: { min: string; avg: string; max: string };
  avg_seller_reputation: number;
  top_sellers: SellerListings[];
}

export function buildMarketplaceStats(marketplace: Marketplace, topN = 5): MarketplaceStats {
  const listings = marketplace.enriched();

  const byCategory: Record<string, number> = {};
  const byStrategy: Record<string, number> = {};
  const bySeller = new Map<string, { listings: number; reputation: number }>();
  let priceSum = 0n;
  let priceMin: bigint | null = null;
  let priceMax: bigint | null = null;
  let repSum = 0;

  for (const l of listings) {
    byCategory[l.category] = (byCategory[l.category] ?? 0) + 1;
    byStrategy[l.strategy] = (byStrategy[l.strategy] ?? 0) + 1;
    priceSum += l.base_price;
    priceMin = priceMin === null || l.base_price < priceMin ? l.base_price : priceMin;
    priceMax = priceMax === null || l.base_price > priceMax ? l.base_price : priceMax;
    repSum += l.reputation_score;
    const s = bySeller.get(l.agent_id) ?? { listings: 0, reputation: l.reputation_score };
    s.listings++;
    bySeller.set(l.agent_id, s);
  }

  const n = listings.length;
  const top_sellers: SellerListings[] = [...bySeller.entries()]
    .map(([agent_id, v]) => ({ agent_id, listings: v.listings, avg_reputation: v.reputation }))
    .sort((a, b) => b.listings - a.listings || b.avg_reputation - a.avg_reputation)
    .slice(0, topN);

  return {
    total_listings: n,
    sellers: bySeller.size,
    by_category: byCategory,
    by_strategy: byStrategy,
    price_motes: {
      min: (priceMin ?? 0n).toString(),
      avg: n ? (priceSum / BigInt(n)).toString() : "0",
      max: (priceMax ?? 0n).toString(),
    },
    avg_seller_reputation: n ? Math.round(repSum / n) : 0,
    top_sellers,
  };
}
