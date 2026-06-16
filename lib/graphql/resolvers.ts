import type { Ledger } from "../ledger/ledger.js";
import type { Agent } from "../core/types.js";

/**
 * GraphQL resolvers + the minimal data source they read from.
 *
 * `GraphQLDataSource` is a structural interface that the API's `ServerState`
 * already satisfies — so the GraphQL layer stays independent of `api/` (no import
 * cycle) and is reusable. Resolvers return JSON-safe values (motes as strings).
 */
export interface GraphQLDataSource {
  readonly ledger: Ledger;
  protocolConfig(): unknown;
  analytics(): unknown;
  categoryAnalytics(): unknown;
  reputationMovers(limit?: number): unknown;
  disputeStats(): unknown;
  x402Stats(): unknown;
  search(q: string): unknown;
  notifications(): unknown;
  timeseries(): unknown;
  economicsView(): unknown;
  marketplaceView(): unknown;
  lpView(): unknown;
  createListing(input: { agent_id: string; category: string; strategy?: string; base_price_cspr: number }): unknown;
  mDeposit(amountCspr: number): unknown;
  complianceScreen(agentId: string): unknown;
  creditExplain(agentId: string): unknown;
  agentProfile(agentId: string): unknown;
  // bureau analytics
  discover(query: { service_type?: string; min_reputation?: number; min_score?: number; limit?: number }): unknown;
  portfolioReport(): unknown;
  attestationGraph(): unknown;
  peerBenchmark(agentId: string): unknown;
  compareAgents(a: string, b: string): unknown;
  creditHistory(agentId: string): unknown;
  scoreTrend(agentId: string): unknown;
  agentMultichain(agentId: string): unknown;
  agentHealth(agentId: string): unknown;
  similarAgents(agentId: string, limit?: number): unknown;
  creditCost(agentId: string, drawCspr: number): unknown;
  onboardingScorecard(agentId: string): unknown;
  riskAlerts(): unknown;
  yieldProjection(): unknown;
  fleetOverview(agentIds: string[]): unknown;
  simulateCredit(input: { monthly_revenue_cspr: number; reputation?: number; stake_cspr?: number }): unknown;
  listCreditOffers(agentId?: string): unknown;
  // mutations
  issueCreditOffer(agentId: string, opts?: { ttl_seconds?: number; term_seconds?: number }): unknown;
  acceptCreditOffer(offerId: string): unknown;
  reviewCreditLine(agentId: string): unknown;
  mRegisterAgent(agentId: string, serviceType: string): unknown;
  mOpenCreditLine(agentId: string): unknown;
  mDrawCredit(agentId: string, amountCspr: number): unknown;
  mRepayCredit(agentId: string, amountCspr: number): unknown;
  mVerifyOperator(operatorId: string, jurisdiction: string, reference: string): unknown;
  mOpenDispute(respondentAgent: string, disputeType: string, note: string): unknown;
  marketplacePurchase(listingId: string, buyerAgent: string): unknown;
  mStake(agentId: string, amountCspr: number): unknown;
}

function serializeAgent(a: Agent): Record<string, unknown> {
  return {
    agent_id: a.agent_id,
    service_type: a.service_type,
    reputation_score: a.reputation_score,
    credit_score: a.credit_score,
    dispute_rate: a.dispute_rate,
    total_jobs_completed: a.total_jobs_completed,
    stake: a.stake.toString(),
    active: a.active,
  };
}

/** Root resolvers bound to a data source (used as graphql() rootValue). */
export function makeRoot(src: GraphQLDataSource) {
  return {
    health: () => ({ ok: true, env: process.env.CRED402_ENV ?? "development", policy: src.ledger.policy.version() }),
    config: () => src.protocolConfig(),
    agents: () => src.ledger.agents.list().map(serializeAgent),
    agent: ({ id }: { id: string }) => {
      const a = src.ledger.agents.get(id);
      return a ? serializeAgent(a) : null;
    },
    creditPool: () => {
      const p = src.ledger.pool.poolState();
      return {
        total_liquidity: p.total_liquidity.toString(),
        outstanding_credit: p.outstanding_credit.toString(),
        interest_accrued: p.interest_accrued.toString(),
        defaults: p.defaults,
        creditLines: src.ledger.pool.list().map((l) => ({
          agent_id: l.agent_id,
          max_credit: l.max_credit.toString(),
          drawn: l.drawn.toString(),
          interest_rate_bps: l.interest_rate_bps,
          status: l.status,
        })),
      };
    },
    creditExplain: ({ agentId }: { agentId: string }) => src.creditExplain(agentId),
    compliance: ({ agentId }: { agentId: string }) => src.complianceScreen(agentId),
    marketplace: () => src.marketplaceView(),
    economics: () => src.economicsView(),
    lp: () => src.lpView(),
    analytics: () => src.analytics(),
    categoryAnalytics: () => src.categoryAnalytics(),
    reputationMovers: ({ limit }: { limit?: number }) => src.reputationMovers(limit),
    disputeStats: () => src.disputeStats(),
    x402Stats: () => src.x402Stats(),
    timeseries: () => src.timeseries(),
    notifications: () => src.notifications(),
    search: ({ q }: { q: string }) => src.search(q),
    agentProfile: ({ id }: { id: string }) => src.agentProfile(id),
    discovery: ({ service_type, min_reputation, min_score, limit }: { service_type?: string; min_reputation?: number; min_score?: number; limit?: number }) =>
      src.discover({ service_type, min_reputation, min_score, limit }),
    portfolio: () => src.portfolioReport(),
    attestationGraph: () => src.attestationGraph(),
    benchmark: ({ agentId }: { agentId: string }) => src.peerBenchmark(agentId),
    compareAgents: ({ a, b }: { a: string; b: string }) => src.compareAgents(a, b),
    creditHistory: ({ agentId }: { agentId: string }) => src.creditHistory(agentId),
    scoreTrend: ({ agentId }: { agentId: string }) => src.scoreTrend(agentId),
    agentMultichain: ({ agentId }: { agentId: string }) => src.agentMultichain(agentId),
    agentHealth: ({ agentId }: { agentId: string }) => src.agentHealth(agentId),
    similarAgents: ({ agentId, limit }: { agentId: string; limit?: number }) => src.similarAgents(agentId, limit),
    creditCost: ({ agentId, draw_cspr }: { agentId: string; draw_cspr: number }) => src.creditCost(agentId, draw_cspr),
    readiness: ({ agentId }: { agentId: string }) => src.onboardingScorecard(agentId),
    riskAlerts: () => src.riskAlerts(),
    yieldProjection: () => src.yieldProjection(),
    fleetOverview: ({ agentIds }: { agentIds: string[] }) => src.fleetOverview(agentIds),
    simulateCredit: ({ monthly_revenue_cspr, reputation, stake_cspr }: { monthly_revenue_cspr: number; reputation?: number; stake_cspr?: number }) =>
      src.simulateCredit({ monthly_revenue_cspr, reputation, stake_cspr }),
    creditOffers: ({ agentId }: { agentId?: string }) => src.listCreditOffers(agentId),
    // mutations (same rootValue object; graphql resolves Mutation fields here too)
    registerAgent: ({ agent_id, service_type }: { agent_id: string; service_type: string }) => src.mRegisterAgent(agent_id, service_type),
    openCreditLine: ({ agent_id }: { agent_id: string }) => src.mOpenCreditLine(agent_id),
    drawCredit: ({ agent_id, amount_cspr }: { agent_id: string; amount_cspr: number }) => src.mDrawCredit(agent_id, amount_cspr),
    repayCredit: ({ agent_id, amount_cspr }: { agent_id: string; amount_cspr: number }) => src.mRepayCredit(agent_id, amount_cspr),
    verifyOperator: ({ operator_id, jurisdiction, reference }: { operator_id: string; jurisdiction: string; reference: string }) => src.mVerifyOperator(operator_id, jurisdiction, reference),
    openDispute: ({ respondent_agent, dispute_type, note }: { respondent_agent: string; dispute_type?: string; note?: string }) => src.mOpenDispute(respondent_agent, dispute_type ?? "bad_evidence", note ?? ""),
    purchaseListing: ({ listing_id, buyer_agent }: { listing_id: string; buyer_agent: string }) => src.marketplacePurchase(listing_id, buyer_agent),
    stakeAgent: ({ agent_id, amount_cspr }: { agent_id: string; amount_cspr: number }) => src.mStake(agent_id, amount_cspr),
    createListing: ({ agent_id, category, strategy, base_price_cspr }: { agent_id: string; category: string; strategy?: string; base_price_cspr: number }) => src.createListing({ agent_id, category, strategy, base_price_cspr }),
    depositLiquidity: ({ amount_cspr }: { amount_cspr: number }) => src.mDeposit(amount_cspr),
    issueCreditOffer: ({ agent_id, ttl_seconds, term_seconds }: { agent_id: string; ttl_seconds?: number; term_seconds?: number }) =>
      src.issueCreditOffer(agent_id, { ttl_seconds, term_seconds }),
    acceptCreditOffer: ({ offer_id }: { offer_id: string }) => src.acceptCreditOffer(offer_id),
    reviewCreditLine: ({ agent_id }: { agent_id: string }) => src.reviewCreditLine(agent_id),
  };
}
