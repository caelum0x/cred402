import { buildSchema } from "graphql";

/**
 * Cred402 GraphQL schema (p2 §7.1).
 *
 * A typed read surface over the same projections the REST `/v1` API exposes —
 * one round-trip for a dashboard to fetch exactly the agents/pool/analytics
 * fields it needs. Top-level entities are strongly typed; richly nested views
 * (analytics, economics, compliance) use a `JSON` scalar so the GraphQL contract
 * tracks the read models without duplicating every field.
 */
export const schema = buildSchema(/* GraphQL */ `
  scalar JSON

  type Health {
    ok: Boolean!
    env: String!
    policy: String!
  }

  type Agent {
    agent_id: ID!
    service_type: String!
    reputation_score: Int!
    credit_score: Int!
    dispute_rate: Float!
    total_jobs_completed: Int!
    stake: String!
    active: Boolean!
  }

  type MarketListing {
    listing_id: ID!
    agent_id: String!
    category: String!
    strategy: String!
    base_price: String!
    reputation_score: Int!
    dispute_rate: Float!
    receipt_count: Int!
    supported_chains: [String!]!
  }

  type Notification {
    id: ID!
    seq: Int!
    severity: String!
    title: String!
    detail: String!
    agent_id: String
    timestamp: Int!
  }

  type SearchResult {
    kind: String!
    id: String!
    label: String!
    detail: String!
  }

  type Query {
    health: Health!
    config: JSON!
    agents: [Agent!]!
    agent(id: ID!): Agent
    agentProfile(id: ID!): JSON
    creditPool: JSON!
    creditExplain(agentId: ID!): JSON
    compliance(agentId: ID!): JSON
    marketplace: [MarketListing!]!
    economics: JSON!
    lp: JSON!
    analytics: JSON!
    categoryAnalytics: JSON!
    reputationMovers(limit: Int): JSON!
    disputeStats: JSON!
    x402Stats: JSON!
    marketplaceStats: JSON!
    timeseries: JSON!
    notifications: [Notification!]!
    search(q: String!): [SearchResult!]!
    discovery(service_type: String, min_reputation: Int, min_score: Int, limit: Int): JSON!
    portfolio: JSON!
    attestationGraph: JSON!
    benchmark(agentId: ID!): JSON
    compareAgents(a: ID!, b: ID!): JSON
    creditHistory(agentId: ID!): JSON
    scoreTrend(agentId: ID!): JSON
    reputationBreakdown(agentId: ID!): JSON
    agentMultichain(agentId: ID!): JSON
    agentHealth(agentId: ID!): JSON
    agentDossier(agentId: ID!): JSON
    similarAgents(agentId: ID!, limit: Int): JSON
    creditCost(agentId: ID!, draw_cspr: Float!): JSON
    safeDraw(agentId: ID!, target_hf_bps: Int): JSON
    readiness(agentId: ID!): JSON
    riskAlerts: JSON!
    yieldProjection: JSON!
    fleetOverview(agentIds: [ID!]!): JSON!
    simulateCredit(monthly_revenue_cspr: Float!, reputation: Float, stake_cspr: Float): JSON!
    creditOffers(agentId: ID): JSON!
  }

  type Mutation {
    registerAgent(agent_id: ID!, service_type: String!): JSON
    openCreditLine(agent_id: ID!): JSON
    drawCredit(agent_id: ID!, amount_cspr: Float!): JSON
    repayCredit(agent_id: ID!, amount_cspr: Float!): JSON
    verifyOperator(operator_id: ID!, jurisdiction: String!, reference: String!): JSON
    openDispute(respondent_agent: ID!, dispute_type: String, note: String): JSON
    purchaseListing(listing_id: ID!, buyer_agent: ID!): JSON
    stakeAgent(agent_id: ID!, amount_cspr: Float!): JSON
    createListing(agent_id: ID!, category: String!, strategy: String, base_price_cspr: Float!): JSON
    depositLiquidity(amount_cspr: Float!): JSON
    issueCreditOffer(agent_id: ID!, ttl_seconds: Int, term_seconds: Int): JSON
    acceptCreditOffer(offer_id: ID!): JSON
    reviewCreditLine(agent_id: ID!): JSON
  }
`);
