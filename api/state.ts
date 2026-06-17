import { Ledger, EventBus, Clock } from "../lib/ledger/index.js";
import { Cred402Economy, type StepLog } from "../agents/economy.js";
import { FraudService } from "../lib/services/fraud_service.js";
import { generateEvmKeypair, type PaymentChallenge } from "../lib/x402/index.js";
import { buildAddressBinding, buildUniversalReceipt } from "../crosschain/standards/index.js";
import { CasperAdapter, EvmAdapter, EvmSatelliteVault, CosmosAdapter, CosmosSatelliteVault, SolanaAdapter, SolanaSatelliteVault } from "../packages/chain-adapters/src/index.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import { Marketplace } from "../lib/services/marketplace.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { cspr, formatCspr } from "../lib/core/units.js";
import { hashObject, shortId } from "../lib/core/hash.js";
import { loadConfig, LedgerJournal } from "../lib/gateway/index.js";
import { ComplianceService } from "../lib/compliance/service.js";
import { AnalyticsService } from "../lib/services/analytics.js";
import { ExplorerService } from "../lib/services/explorer.js";
import { NotificationService } from "../lib/services/notifications.js";
import { buildTimeseries } from "../lib/services/timeseries.js";
import { generateCreditReport } from "../lib/services/credit_report.js";
import { buildLpView } from "../lib/services/lp_positions.js";
import { applyReputationDecay } from "../lib/services/reputation_decay.js";
import { stressCurve } from "../lib/services/stress_test.js";
import { GovernanceProposals } from "../lib/services/governance_proposals.js";
import { computeTier, tierLeaderboard } from "../lib/services/reputation_tiers.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { buildComplianceReport } from "../lib/services/compliance_report.js";
import { discoverAgents, type DiscoveryQuery } from "../lib/services/discovery.js";
import { buildPortfolioReport } from "../lib/services/portfolio.js";
import { simulateUnderwriting, type SimulationInput } from "../lib/services/credit_simulator.js";
import { buildPeerBenchmark } from "../lib/services/peer_benchmark.js";
import { CreditOffers } from "../lib/services/credit_offers.js";
import { buildCreditHistory } from "../lib/services/credit_history.js";
import { buildRiskAlerts } from "../lib/services/risk_alerts.js";
import { buildYieldProjection } from "../lib/services/yield_projection.js";
import { buildOnboardingScorecard } from "../lib/services/onboarding_scorecard.js";
import { buildScoreTrend } from "../lib/services/score_trend.js";
import { buildFleetOverview } from "../lib/services/fleet_overview.js";
import { reviewCreditLine } from "../lib/services/credit_review.js";
import { buildAgentMultichainSummary } from "../lib/services/agent_multichain.js";
import { WalletAuth } from "../lib/services/wallet_auth.js";
import { compareAgents } from "../lib/services/agent_compare.js";
import { buildCategoryAnalytics } from "../lib/services/category_analytics.js";
import { buildReputationMovers } from "../lib/services/reputation_movers.js";
import { buildAgentHealthBadge } from "../lib/services/agent_health.js";
import { computeCreditCost } from "../lib/services/credit_cost.js";
import { buildDisputeStats } from "../lib/services/dispute_stats.js";
import { buildX402Stats } from "../lib/services/x402_stats.js";
import { buildProtocolConfig } from "../lib/services/protocol_config.js";
import { findSimilarAgents } from "../lib/services/similar_agents.js";
import { buildAgentDossier } from "../lib/services/agent_dossier.js";
import { computeSafeDraw } from "../lib/services/safe_draw.js";
import { buildLpDepositPreview } from "../lib/services/lp_deposit_preview.js";
import { buildMarketplaceStats } from "../lib/services/marketplace_stats.js";
import { buildReputationBreakdown } from "../lib/services/reputation_breakdown.js";
import { Cred402CreditOracle } from "../lib/services/credit_oracle.js";
import { CrossChainReconciler } from "../lib/services/crosschain_reconciliation.js";
import { CreditDataCommons } from "../lib/services/credit_data_commons.js";
import { RiskEngineV2 } from "../lib/services/risk_engine_v2.js";
import { ServiceVerticals } from "../lib/services/service_verticals.js";

/**
 * Server state — one persistent ledger + economy shared across all HTTP requests
 * so the dashboard reflects live on-chain state. Pending x402 challenges issued
 * by the paid endpoints are tracked here until they are paid.
 */
export class ServerState {
  economy: Cred402Economy;
  marketplace: Marketplace;
  governanceProposals: GovernanceProposals;
  attestations: AttestationGraph;
  creditOffers: CreditOffers;
  /** Sign-in-with-Casper-Wallet challenge/session store (persists across resets). */
  readonly walletAuth = new WalletAuth();
  /** Service-vertical underwriting profiles (p10) — governance-tunable, persisted. */
  readonly verticals = new ServiceVerticals();
  readonly economics = new ProtocolEconomics();
  readonly pendingChallenges = new Map<string, PaymentChallenge>();
  // Persistent bus/clock so live SSE subscribers survive a ledger reset.
  private readonly bus = new EventBus();
  private readonly clock = new Clock();

  /** Durable append-only event journal (enabled when CRED402_DATA_DIR is set). */
  readonly journal?: LedgerJournal;

  constructor() {
    this.economy = new Cred402Economy(new Ledger(this.bus, this.clock));
    this.economy.bootstrap();
    this.economy.createJob();
    this.marketplace = new Marketplace(this.ledger);
    this.governanceProposals = new GovernanceProposals(this.ledger, 100, 3600);
    this.attestations = new AttestationGraph(this.ledger);
    this.creditOffers = new CreditOffers(this.ledger, this.economy.credit);
    this.seedMarketplace();
    const dataDir = loadConfig().dataDir;
    if (dataDir) this.journal = new LedgerJournal(dataDir, this.bus);
  }

  /** List the seller's services across a few pricing strategies (p4 §18). */
  private seedMarketplace(): void {
    const seller = this.economy.seller.agent_id;
    if (this.marketplace.enriched().length > 0) return;
    try {
      this.marketplace.list({ agent_id: seller, category: "rwa.energy_output", strategy: "fixed", base_price: cspr("0.002") });
      this.marketplace.list({ agent_id: seller, category: "rwa.weather_risk", strategy: "dynamic", base_price: cspr("0.002") });
      this.marketplace.list({ agent_id: seller, category: "rwa.payment_monitoring", strategy: "reputation_tiered", base_price: cspr("0.0015") });
    } catch {
      /* agent not registered yet — seeded lazily on first view */
    }
  }

  /** Enriched marketplace listings for the console (p4 §18), seeding if empty. */
  marketplaceView() {
    this.seedMarketplace();
    return this.marketplace.enriched().map((l) => ({
      ...l,
      base_price: l.base_price.toString(),
      min_payment: l.min_payment.toString(),
      stake: l.stake.toString(),
      margin_bps: Number(l.margin_bps),
    }));
  }

  /** Pool health + fee schedule for the console economics view (p4 §11). */
  economicsView() {
    const pool = this.ledger.pool.poolState();
    const slashes = this.ledger.slashing.list();
    const defaultLosses = slashes.reduce((s, r) => s + BigInt(r.amount ?? 0n), 0n);
    const health = this.economics.poolHealth({
      total_liquidity: BigInt(pool.total_liquidity),
      outstanding_credit: BigInt(pool.outstanding_credit),
      interest_accrued: BigInt(pool.interest_accrued),
      fees_collected: 0n, // origination/late fees not tracked separately in the pool state
      default_losses: defaultLosses,
      elapsed_seconds: Math.max(1, this.ledger.clock.now()),
    });
    return {
      fees: {
        facilitator_fee_bps: Number(this.economics.fees.facilitator_fee_bps),
        origination_fee_bps: Number(this.economics.fees.origination_fee_bps),
        interest_spread_bps: Number(this.economics.fees.interest_spread_bps),
        late_fee_bps: Number(this.economics.fees.late_fee_bps),
      },
      health: {
        utilization: health.utilization,
        realized_apy: health.realized_apy,
        realized_yield: health.realized_yield.toString(),
        loss_rate: health.loss_rate,
        risk_flags: health.risk_flags,
      },
    };
  }

  /** Read-only credit explanation with structured reason codes (p5 §15). */
  creditExplain(agentId: string) {
    return this.economy.credit.explain(agentId);
  }

  /** Compliance screening (p2 §7.9) for an agent, plus the data-retention policy. */
  complianceScreen(agentId: string) {
    const svc = new ComplianceService(this.ledger);
    return { screen: svc.screenAgent(agentId), retention: svc.retention.all() };
  }

  /** Live protocol analytics for the Analytics page. */
  analytics() {
    return new AnalyticsService(this.ledger).compute();
  }

  /** Universal explorer search across the ledger. */
  search(query: string) {
    return new ExplorerService(this.ledger).search(query);
  }

  /** Human notification feed derived from the event stream. */
  notifications() {
    return new NotificationService(this.ledger).feed();
  }

  /** Cumulative protocol time-series (liquidity/outstanding/receipts) for charts. */
  timeseries() {
    return buildTimeseries(this.ledger);
  }

  /** Formal FICO-style credit report for an agent. */
  creditReport(agentId: string) {
    return generateCreditReport(this.ledger, agentId);
  }

  /** Liquidity-provider positions + pro-rata yield. */
  lpView() {
    return buildLpView(this.ledger);
  }

  /** Pool stress test — default-wave solvency curve. */
  stressTest() {
    return stressCurve(this.ledger);
  }

  /** Per-jurisdiction compliance report (KYB coverage + sanctions exposure). */
  complianceReport() {
    return buildComplianceReport(this.ledger);
  }

  /** An agent vouches for another (web of trust). */
  attest(from: string, to: string, note: string) {
    try {
      return this.attestations.attest(from, to, note);
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  attestationsFor(agentId: string) {
    return this.attestations.forAgent(agentId);
  }
  /** Full web-of-trust graph (nodes + directed vouch edges). */
  attestationGraph() {
    return this.attestations.graph();
  }
  /** Buyer-facing agent discovery — composite ranking across all signals. */
  discover(query: DiscoveryQuery) {
    return discoverAgents(this.ledger, this.attestations, query);
  }
  /** LP-facing portfolio & concentration-risk report (HHI, exposure breakdowns). */
  portfolioReport() {
    return buildPortfolioReport(this.ledger);
  }
  /** Read-only "what-if" underwriting preview against the live risk policy. */
  simulateCredit(input: SimulationInput) {
    return simulateUnderwriting(this.ledger, input);
  }
  /** Percentile benchmark of an agent against its service-type cohort. */
  peerBenchmark(agentId: string) {
    return buildPeerBenchmark(this.ledger, agentId);
  }
  /** Credit pre-approval offers (issue / accept / decline / list). */
  issueCreditOffer(agentId: string, opts: { ttl_seconds?: number; term_seconds?: number } = {}) {
    return this.creditOffers.issue(agentId, opts);
  }
  acceptCreditOffer(offerId: string) {
    return this.creditOffers.accept(offerId);
  }
  declineCreditOffer(offerId: string) {
    return this.creditOffers.decline(offerId);
  }
  listCreditOffers(agentId?: string) {
    return this.creditOffers.list(agentId);
  }
  /** Chronological credit file (every event concerning an agent). */
  creditHistory(agentId: string) {
    return buildCreditHistory(this.ledger, agentId);
  }
  /** Always-on risk monitoring sweep → severity-ranked actionable alerts. */
  riskAlerts() {
    return buildRiskAlerts(this.ledger);
  }
  /** LP forward yield projection (gross/LP interest, expected loss, net APY). */
  yieldProjection() {
    return buildYieldProjection(this.ledger, this.economics);
  }
  /** Credit-as-a-service oracle check ("Cred402 Inside", p3) — the read other
   * x402 protocols query for an agent's creditworthiness. */
  creditCheck(agentId: string) {
    return new Cred402CreditOracle(this.ledger).creditCheck(agentId);
  }
  /** Batch oracle check — rank a set of agents by creditworthiness (p3). */
  creditChecks(agentIds: string[]) {
    return new Cred402CreditOracle(this.ledger).creditChecks(agentIds);
  }
  /** ML risk-engine v2 score (p7) — learned PD + rules score + blended score. */
  riskScoreV2(agentId: string) {
    return new RiskEngineV2(this.ledger).score(agentId);
  }
  /** Anonymized, k-anonymous public credit-data commons snapshot (p6 data moat). */
  dataCommons() {
    return new CreditDataCommons(this.ledger).snapshot();
  }
  /** Global cross-chain exposure reconciliation across all agents (p5). */
  exposureReconciliation() {
    return new CrossChainReconciler(this.ledger).reconcileAll();
  }
  /** One agent's Casper-rooted exposure + global headroom (p5). */
  agentExposure(agentId: string) {
    const recon = new CrossChainReconciler(this.ledger);
    return { ...recon.reconcile(agentId), global_headroom_motes: recon.globalHeadroom(agentId).toString() };
  }
  /** Service-vertical underwriting profiles (p10). */
  verticalProfiles() {
    return this.verticals.list();
  }
  /** One service-vertical underwriting profile by name (p10). */
  verticalProfile(name: string) {
    return this.verticals.get(name) ?? { error: `unknown vertical: ${name}` };
  }
  /** Onboarding readiness scorecard — what an agent needs to qualify for credit. */
  onboardingScorecard(agentId: string) {
    return buildOnboardingScorecard(this.ledger, agentId);
  }
  /** Credit-score & reputation trend reconstructed from the event log. */
  scoreTrend(agentId: string) {
    return buildScoreTrend(this.ledger, agentId);
  }
  /** Fleet overview — readiness + discovery standing for a list of agents, for
   * operators managing many agents in one call. */
  fleetOverview(agentIds: string[]) {
    return buildFleetOverview(this.ledger, this.attestations, agentIds);
  }
  /** Review an existing credit line — ratchet the limit up if the agent now
   * qualifies for more; never auto-reduce. */
  reviewCreditLine(agentId: string) {
    return reviewCreditLine(this.ledger, this.economy.credit, agentId);
  }
  /** Per-agent cross-chain footprint: bindings, external receipts, CANs, exposure. */
  agentMultichain(agentId: string) {
    return buildAgentMultichainSummary(this.ledger, agentId);
  }
  /** Side-by-side comparison of two agents with a per-metric + overall winner. */
  compareAgents(a: string, b: string) {
    return compareAgents(this.ledger, this.attestations, a, b);
  }
  /** Market intelligence aggregated by service category. */
  categoryAnalytics() {
    return buildCategoryAnalytics(this.ledger);
  }
  /** Biggest reputation gainers and losers (momentum from the event log). */
  reputationMovers(limit?: number) {
    return buildReputationMovers(this.ledger, limit);
  }
  /** Glanceable green/amber/red health verdict for an agent. */
  agentHealth(agentId: string) {
    return buildAgentHealthBadge(this.ledger, agentId);
  }
  /** Itemized cost of a specific draw against an agent's line. */
  creditCost(agentId: string, drawCspr: number) {
    return computeCreditCost(this.ledger, this.economics, agentId, drawCspr);
  }
  /** Protocol-level dispute statistics (outcomes, types, slashing). */
  disputeStats() {
    return buildDisputeStats(this.ledger);
  }
  /** x402 receipt-network statistics (volume, settlement, top counterparties). */
  x402Stats() {
    return buildX402Stats(this.ledger);
  }
  /** Self-documenting protocol config: fees, credit gates, reputation-tier perks. */
  protocolConfig() {
    return buildProtocolConfig(this.ledger);
  }
  /** Comparable alternative agents for a given agent ("you might also consider"). */
  similarAgents(agentId: string, limit?: number) {
    return findSimilarAgents(this.ledger, this.attestations, agentId, limit);
  }
  /** One-call integrator dossier: tier + health + readiness + benchmark + line. */
  agentDossier(agentId: string) {
    return buildAgentDossier(this.ledger, this.attestations, agentId);
  }
  /** Largest additional draw keeping the line at/above a target health factor. */
  safeDraw(agentId: string, targetHfBps?: number) {
    return computeSafeDraw(this.ledger, agentId, targetHfBps);
  }
  /** Preview an LP deposit: resulting share, utilization, projected yield. */
  lpDepositPreview(depositCspr: number) {
    return buildLpDepositPreview(this.ledger, this.economics, depositCspr);
  }
  /** Marketplace supply-side statistics (categories, strategies, prices, sellers). */
  marketplaceStats() {
    return buildMarketplaceStats(this.marketplace);
  }
  /** Per-dimension breakdown of an agent's composite reputation. */
  reputationBreakdown(agentId: string) {
    return buildReputationBreakdown(this.ledger, agentId);
  }
  /** Issue a sign-in challenge for a Casper account to sign in its wallet. */
  walletChallenge(account: string) {
    return this.walletAuth.challenge(account);
  }
  /** Verify a signed challenge → mint a session token. */
  walletVerify(nonce: string, signature: string) {
    return this.walletAuth.verify(nonce, signature);
  }
  /** Agents owned by the wallet account behind a session token ("my agents"). */
  walletAgents(token: string) {
    const session = this.walletAuth.session(token);
    if (!session) return { error: "invalid or expired session" };
    const owned = this.ledger.agents.list().filter((a) => a.owner_public_key === session.account);
    return {
      account: session.account,
      count: owned.length,
      agents: owned.map((a) => ({
        agent_id: a.agent_id,
        service_type: a.service_type,
        reputation: a.reputation_score,
        credit_score: a.credit_score,
        active: a.active,
      })),
    };
  }
  /** Review every active credit line (periodic portfolio maintenance). */
  reviewAllCreditLines() {
    const lines = this.ledger.pool.list().filter((l) => l.status === "active");
    const results = lines.map((l) => reviewCreditLine(this.ledger, this.economy.credit, l.agent_id));
    const ok = results.filter((r): r is Exclude<typeof r, { error: string }> => !("error" in r));
    return {
      reviewed: ok.length,
      increased: ok.filter((r) => r.action === "increased").length,
      held: ok.filter((r) => r.action === "held").length,
      ineligible: ok.filter((r) => r.action === "ineligible").length,
      errors: results.length - ok.length,
      results,
    };
  }

  /** Reputation tier (badge + perks) for an agent, or the tier leaderboard. */
  tier(agentId: string) {
    return computeTier(this.ledger, agentId);
  }
  tiers() {
    return tierLeaderboard(this.ledger);
  }

  /** Set an agent's declared capabilities + spending limit (Agent Passport). */
  setCapabilities(agentId: string, capabilities: string[], spendingLimitCspr?: number) {
    if (!this.ledger.agents.get(agentId)) return { error: "unknown agent" };
    this.ledger.passports.set_profile(agentId, {
      capabilities,
      ...(spendingLimitCspr !== undefined ? { spending_limit: cspr(spendingLimitCspr) } : {}),
    });
    return this.ledger.buildPassport(agentId);
  }

  /** Credit-line health: utilization, overdue status, health factor per line. */
  creditHealth() {
    const now = this.ledger.clock.now();
    return this.ledger.pool.list().map((l) => ({
      agent_id: l.agent_id,
      status: l.status,
      drawn_motes: l.drawn.toString(),
      max_credit_motes: l.max_credit.toString(),
      utilization: Number(l.max_credit) > 0 ? Number(l.drawn) / Number(l.max_credit) : 0,
      health_factor_bps: l.health_factor_bps,
      accrued_interest_motes: this.ledger.pool.accruedInterest(l).toString(),
      overdue: l.drawn > 0n && l.due_timestamp < now,
      due_in_seconds: l.due_timestamp - now,
    }));
  }

  /** Advance the protocol clock (admin/testing) so interest accrues over periods. */
  advanceClock(seconds: number) {
    this.ledger.clock.advance(seconds);
    return { now: this.ledger.clock.now(), advanced_seconds: seconds };
  }

  /** Freeze a credit line (ops / risk action). */
  freezeLine(agentId: string, reason: string) {
    this.ledger.pool.freeze(agentId, reason);
    return this.ledger.pool.get(agentId) ?? { error: "no line" };
  }

  /** Apply reputation time-decay to inactive agents (p2 §6.6). */
  applyDecay(assumeInactiveDays?: number) {
    return applyReputationDecay(this.ledger, assumeInactiveDays !== undefined ? { assumeInactiveDays } : {});
  }

  /** Pay an insurance claim from the slashing reserve (p2 §6.10). */
  mClaimInsurance(claimant: string, amountCspr: number, reason: string) {
    try {
      return this.ledger.slashing.claim_insurance(claimant, cspr(amountCspr), reason);
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /** An agent lists a service on the marketplace (p4 §18). */
  createListing(input: { agent_id: string; category: string; strategy?: string; base_price_cspr: number }) {
    try {
      return this.marketplace.list({
        agent_id: input.agent_id,
        category: input.category as never,
        strategy: (input.strategy as never) ?? "fixed",
        base_price: cspr(input.base_price_cspr),
      });
    } catch (err) {
      return { error: (err as Error).message };
    }
  }

  /**
   * Functional agent-to-agent marketplace commerce: a buyer purchases a listed
   * service from any seller agent. Records a facilitator-settled x402 receipt
   * that builds the seller's verifiable revenue + reputation (the flywheel).
   */
  marketplacePurchase(listingId: string, buyerAgent: string) {
    const listing = this.marketplace.get(listingId);
    if (!listing) return { error: "unknown listing" };
    const seller = this.ledger.agents.get(listing.agent_id);
    if (!seller) return { error: "unknown seller" };
    if (!this.ledger.agents.get(buyerAgent)) return { error: "unknown buyer agent" };

    const quote = this.marketplace.quote(listingId);
    const amount = quote.price;
    const now = this.ledger.clock.now();
    const nonce = shortId("mkt");
    const proofHash = hashObject({ buyer: buyerAgent, seller: listing.agent_id, amount: amount.toString(), nonce });
    const receipt = this.ledger.receipts.record_receipt({
      payer_agent: buyerAgent,
      seller_agent: listing.agent_id,
      service_type: seller.service_type,
      amount,
      rwa_reference_hash: "0xmarket",
      result_hash: hashObject({ listing: listingId, ts: now }),
      payment_proof_hash: proofHash,
      nonce,
      expires_at: now + 300,
    });
    this.ledger.receipts.settle_receipt(receipt.receipt_id);
    this.ledger.receipts.finalize_receipt(receipt.receipt_id);
    this.ledger.agents.record_job(
      listing.agent_id,
      { receipt_id: receipt.receipt_id, amount, timestamp: now, service_type: seller.service_type },
      90,
      false,
    );
    this.ledger.agents.update_reputation(listing.agent_id, +1, proofHash, "FINALIZED_VERIFIED_SERVICE");
    return { receipt, quote: { price: amount.toString(), strategy: quote.strategy, breakdown: quote.breakdown } };
  }

  /** Run one real x402 purchase and return the full trace (402 → sign → 200). */
  async x402Buy(evidenceType: string, tampered = false) {
    const result = await this.economy.buyer.buyEvidence(this.economy.seller, "SOLAR-A17", evidenceType, cspr("0.002"), { tampered });
    return {
      evidence_type: result.evidence_type,
      challenge_headers: result.challenge_headers,
      receipt: result.receipt,
      report: result.report,
    };
  }

  /** Ops incident board: fraud watchlist, defaults, frozen lines, open disputes. */
  incidents() {
    const fraud = this.fraudReports();
    const lines = this.ledger.pool.list();
    const disputes = this.ledger.disputes.list();
    return {
      fraud_watchlist: fraud
        .filter((r) => r.score >= 40)
        .sort((a, b) => b.score - a.score)
        .map((r) => ({ agent_id: r.agent_id, score: r.score, flags: r.flags.map((f) => f.code) })),
      frozen_lines: lines.filter((l) => l.status === "frozen").map((l) => l.agent_id),
      defaulted_lines: lines.filter((l) => l.status === "defaulted").map((l) => l.agent_id),
      open_disputes: disputes
        .filter((d) => d.status !== "resolved" && d.status !== "closed")
        .map((d) => ({ dispute_id: d.dispute_id, respondent: d.respondent_agent, type: d.dispute_type, status: d.status })),
      defaults_total: this.ledger.pool.poolState().defaults,
      paused: {
        credit_draws: this.ledger.governance.get().paused_credit_draws,
        registrations: this.ledger.governance.get().paused_registrations,
        receipt_finalization: this.ledger.governance.get().paused_receipt_finalization,
      },
    };
  }

  // -- GraphQL/SDK mutation wrappers (thin, over the economy/ledger) ----------

  mRegisterAgent(agentId: string, serviceType: string) {
    this.ledger.agents.register_agent({ agent_id: agentId, owner_public_key: "01", agent_public_key: "01", service_type: serviceType as never });
    return this.ledger.buildPassport(agentId);
  }
  mOpenCreditLine(agentId: string) {
    return this.economy.credit.underwrite(agentId);
  }
  mDrawCredit(agentId: string, amountCspr: number) {
    return this.economy.treasury.fundDraw(agentId, amountCspr);
  }
  mRepayCredit(agentId: string, amountCspr: number) {
    return this.economy.treasury.collectRepayment(agentId, amountCspr);
  }
  mVerifyOperator(operatorId: string, jurisdiction: string, reference: string) {
    return this.realfi.verifyOperator({ operator_id: operatorId, verification_level: "business_verified", jurisdiction, verification_reference: reference });
  }
  mDeposit(amountCspr: number) {
    this.economy.treasury.depositLiquidity(amountCspr);
    return this.ledger.pool.poolState();
  }
  mWithdraw(amountCspr: number) {
    try {
      this.ledger.pool.withdraw_liquidity(cspr(amountCspr));
      return this.ledger.pool.poolState();
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  mStake(agentId: string, amountCspr: number) {
    if (!this.ledger.agents.get(agentId)) return { error: "unknown agent" };
    this.ledger.agents.stake(agentId, cspr(amountCspr));
    const agent = this.ledger.agents.get(agentId)!;
    return { agent_id: agentId, stake_motes: agent.stake.toString(), credit_explain: this.economy.credit.explain(agentId) };
  }
  mResolveDispute(disputeId: string, verdict: string, slashCspr: number) {
    try {
      const d = this.ledger.disputes.issue_verdict(disputeId, verdict as never, cspr(slashCspr), [`resolved via API: ${verdict}`]);
      // Enforce the verdict: slash + reputation hit if the agent lost.
      if (verdict === "agent_loses" && slashCspr > 0) {
        this.ledger.agents.slash(d.respondent_agent, cspr(slashCspr), hashObject({ dispute: disputeId }));
        // Route the slashed stake into the vault (victim/insurance/treasury split).
        this.ledger.slashing.apply_slash({ agent_id: d.respondent_agent, amount: cspr(slashCspr), reason: `dispute ${disputeId} ${verdict}`, dispute_id: disputeId });
        this.ledger.agents.update_reputation(d.respondent_agent, -25, hashObject({ dispute: disputeId }), "BAD_EVIDENCE_VERDICT");
      }
      this.ledger.disputes.close(disputeId);
      return d;
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
  mOpenDispute(respondentAgent: string, disputeType: string, note: string) {
    return this.ledger.disputes.open({
      dispute_type: (disputeType as never) ?? "bad_evidence",
      complainant: "graphql",
      respondent_agent: respondentAgent,
      note: note ?? "opened via graphql",
      evidence_hash: "0x" + "00".repeat(32),
    });
  }

  /** Aggregated 360° profile for one agent — powers the console agent drill-down. */
  agentProfile(agentId: string) {
    const agent = this.ledger.agents.get(agentId);
    if (!agent) return { error: "unknown agent" };
    const operatorId = this.ledger.buildPassport(agentId)?.operator;
    return {
      passport: this.ledger.buildPassport(agentId),
      tier: computeTier(this.ledger, agentId),
      credit_explain: this.economy.credit.explain(agentId),
      compliance: this.complianceScreen(agentId).screen,
      credit_line: this.ledger.pool.get(agentId) ?? null,
      receipts: this.ledger.receipts.forSeller(agentId),
      evidence: this.ledger.evidence.list().filter((e) => e.agent_id === agentId),
      realfi: {
        operator_id: operatorId,
        verified: operatorId ? this.ledger.operators.is_verified(operatorId) : false,
        fiat_receipts: this.ledger.fiatReceipts.forSeller(agentId).length,
      },
      reputation_events: this.ledger.bus
        .all()
        .filter((e) => e.name === "ReputationUpdated" && (e.data as { agent_id?: string }).agent_id === agentId)
        .map((e) => ({ seq: e.seq, ...(e.data as Record<string, unknown>) })),
    };
  }

  get ledger(): Ledger {
    return this.economy.ledger;
  }

  /** Fraud reports for every agent (p2 §7.8). */
  fraudReports() {
    const svc = new FraudService(this.ledger);
    return this.ledger.agents.list().map((a) => svc.analyze(a.agent_id));
  }

  /** RealFi Bridge bound to the current ledger (p6). */
  get realfi(): RealFiBridge {
    return new RealFiBridge(this.ledger);
  }

  /** Snapshot of the RealFi layer for the console. */
  realfiState() {
    return {
      fiatReceipts: this.ledger.fiatReceipts.list(),
      operatorVerifications: this.ledger.operators.list(),
      attestations: this.ledger.realfi.list(),
    };
  }

  /**
   * Run the p6 RealFi flow on the current ledger: verify the seller's operator via
   * Stripe Identity, record settled fiat billing + Plaid cashflow, and re-underwrite
   * to show the bounded credit uplift — populating the RealFi dashboard tab.
   */
  runRealFi(): StepLog[] {
    const econ = this.economy;
    const ledger = this.ledger;
    const seller = econ.seller.agent_id;
    const operatorId = "operator:0xA17solarspv";
    ledger.passports.set_profile(seller, { operator: operatorId });
    const bridge = this.realfi;
    const scenes: StepLog[] = [];

    const before = econ.credit.underwrite(seller).line.max_credit;

    bridge.verifyOperator({
      operator_id: operatorId,
      verification_level: "business_verified",
      jurisdiction: "TR",
      verification_reference: "stripe_idv_ref_" + ledger.operators.list().length,
    });
    for (let i = 0; i < 4; i++) {
      bridge.recordFiatReceipt({
        provider_event_id: `evt_${ledger.fiatReceipts.list().length}_${i}`,
        provider_receipt_id: `ch_${ledger.fiatReceipts.list().length}_${i}`,
        payer_type: "enterprise_customer",
        seller_agent: seller,
        operator_id: operatorId,
        amount: "100.00",
        currency: "USD",
        service_type: "rwa.weather_risk",
        request_hash: "0xreq",
        result_hash: "0xres",
      });
    }
    bridge.recordBankVerification({
      operator_id: operatorId,
      account_ownership_verified: true,
      cashflow_report: { monthly_inflow_usd: 9800, months: 12 },
      balance_snapshot: { usd: 24000 },
      data_period_start: ledger.clock.now() - 31_536_000,
      data_period_end: ledger.clock.now(),
    });

    const after = econ.credit.underwrite(seller);
    scenes.push({
      scene: "RealFi Bridge — verify operator + fiat billing + bank data (no PII)",
      lines: [
        `operator ${operatorId} verified: ${ledger.operators.is_verified(operatorId)}`,
        `on-chain fiat receipts: ${ledger.fiatReceipts.forSeller(seller).length} (hashes only)`,
        `credit line ${formatCspr(before)} → ${formatCspr(after.line.max_credit)} CSPR`,
        `realfi reason codes: ${(after.decision.reason_codes ?? []).filter((c) => ["VERIFIED_OPERATOR", "FIAT_REVENUE", "BANK_CASHFLOW_VERIFIED"].includes(c.code)).map((c) => c.code).join(", ")}`,
      ],
    });
    return scenes;
  }

  /** Run the full honest loop (idempotent-ish: resets first for a clean demo). */
  async runDemo(opts: { dispute?: boolean } = {}): Promise<StepLog[]> {
    this.reset();
    const econ = this.economy;
    const scenes: StepLog[] = [];
    scenes.push(econ.bootstrap());
    scenes.push(econ.createJob());
    const { log, reports } = await econ.runEvidencePurchases({ tamperEnergy: opts.dispute });
    scenes.push(log);
    const audit = await econ.runWatchdogAudit(reports);
    scenes.push(audit.log);
    if (audit.disputed) return scenes;
    scenes.push(econ.applyReputationEngine());
    scenes.push(econ.scoreJob());
    scenes.push(econ.underwriteSeller().log);
    scenes.push(econ.drawCredit(6));
    scenes.push(econ.repay(2));
    scenes.push(econ.routeLiquidity());
    return scenes;
  }

  /**
   * Run the p3 omnichain flow on the current ledger: bind an EVM address, earn on
   * Base, anchor the receipt to Casper, issue a CAN, lend on the satellite vault,
   * and repay — populating the Multichain dashboard tab with real data.
   */
  async runMultichain(): Promise<StepLog[]> {
    const econ = this.economy;
    const ledger = this.ledger;
    const agentId = econ.seller.agent_id;
    const BASE = "eip155:8453";
    const POOL = "0xbasepoolcred402vault000000000000000000a1";

    const casper = new CasperAdapter(ledger);
    const vault = new EvmSatelliteVault(BASE, POOL, ledger.policyPublicKeyHex, 1_000_000_000n);
    const evm = new EvmAdapter(BASE, vault, () => ledger.clock.now());
    const scenes: StepLog[] = [];

    // 1. bind
    const evmKeys = generateEvmKeypair();
    const abe = buildAddressBinding({
      agent_id: agentId,
      casper_account: econ.seller.publicKeyHex,
      casper_private_pem: econ.seller.keys.privatePem,
      external_chain: BASE,
      external_address: evmKeys.address,
      external_private_key: evmKeys.privateKey,
      expires_at: ledger.clock.now() + 31_536_000,
    });
    const bound = await casper.bindAgentAddress(abe);
    await evm.bindAgentAddress(abe);
    scenes.push({ scene: "Bind EVM address to Casper agent", lines: [`bound ${evmKeys.address} → ${agentId} (${bound.ok ? "dual-sig verified" : bound.detail})`] });

    // 2. earn on Base -> anchor to Casper
    const { envelope: ure } = buildUniversalReceipt({
      origin_chain: BASE, settlement_network: "base", payer_agent_id: "rwa-request-agent-base", seller_agent_id: agentId,
      payer_address: "0x1111111111111111111111111111111111111111", seller_address: evmKeys.address,
      asset: "USDC", amount: "40000000", service_type: "rwa.weather_risk",
      request_hash: "0xreq", result_hash: "0xres", payment_proof_hash: "0x" + evmKeys.address.slice(2) + "proof",
      settlement_tx_hash: "0xbasetx", nonce: "0xnonce-" + ledger.externalReceipts.list().length, created_at: ledger.clock.now(),
    });
    await evm.submitReceipt(ure);
    const repBefore = ledger.agents.get(agentId)!.reputation_score;
    const anchored = await casper.submitReceipt(ure);
    const repAfter = ledger.agents.get(agentId)!.reputation_score;
    scenes.push({ scene: "Earn 40 USDC on Base → anchor to Casper", lines: [`anchored ${anchored.tx_hash.slice(0, 18)}…`, `reputation ${repBefore} → ${repAfter}`] });

    // 3. issue CAN (reserve global exposure)
    const agent = ledger.agents.get(agentId)!;
    ledger.exposure.ensure_agent(agentId, 2_000_000_000n);
    const can = ledger.notes.issue_can({
      agent_id: agentId, credit_score: Math.max(agent.credit_score, 80), risk_policy_version: 1,
      target_chain: BASE, target_pool: POOL, max_draw: 500_000_000n, asset: "USDC",
    });
    scenes.push({ scene: "Casper issues a Credit Authorization Note", lines: [`CAN ${can.note_id.slice(0, 18)}… max_draw $${Number(can.max_draw) / 1e6}`] });

    // 4. draw on EVM, confirm on Casper
    const draw = await evm.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
    if (draw.ok) await casper.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
    scenes.push({ scene: "Borrow $300 on Base under Casper risk control", lines: [`vault lent $300, liquidity $${Number(vault.availableLiquidity()) / 1e6}`] });

    // 5. repay
    await evm.repayCredit({ agent_id: agentId, amount: "300000000" });
    await casper.repayCredit({ agent_id: agentId, amount: "300000000" });
    scenes.push({ scene: "Repay → Casper releases exposure", lines: [`outstanding $${Number(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding) / 1e6}`] });

    // 6. SECOND satellite family — Cosmos (Osmosis). Same Casper root, same global
    //    exposure cap: credit drawn on Cosmos consumes the same agent ceiling as
    //    Base, proving the over-borrow guard holds across heterogeneous chains.
    const COSMOS = "cosmos:osmosis-1";
    const COSMOS_POOL = "osmo1vaultcred402creditpool00000000000000000q";
    const cosmosVault = new CosmosSatelliteVault(COSMOS, COSMOS_POOL, ledger.policyPublicKeyHex, 1_000_000_000n, "uusdc");
    const cosmos = new CosmosAdapter(COSMOS, cosmosVault, () => ledger.clock.now());

    // 6a. earn 25 USDC on Osmosis (IBC) → anchor to Casper
    const { envelope: cre } = buildUniversalReceipt({
      origin_chain: COSMOS, settlement_network: "osmosis", payer_agent_id: "rwa-request-agent-cosmos", seller_agent_id: agentId,
      payer_address: "osmo1payer000000000000000000000000000000000q", seller_address: "osmo1seller00000000000000000000000000000000q",
      asset: "USDC", amount: "25000000", service_type: "rwa.weather_risk",
      request_hash: "0xreqcosmos", result_hash: "0xrescosmos", payment_proof_hash: "0xcosmosproof",
      settlement_tx_hash: "C05305TXHASH", nonce: "0xnonce-cosmos-" + ledger.externalReceipts.list().length, created_at: ledger.clock.now(),
    });
    await cosmos.submitReceipt(cre);
    const cRepBefore = ledger.agents.get(agentId)!.reputation_score;
    const cAnchored = await casper.submitReceipt(cre);
    const cRepAfter = ledger.agents.get(agentId)!.reputation_score;
    scenes.push({ scene: "Earn 25 USDC on Osmosis → anchor to Casper", lines: [`anchored ${cAnchored.tx_hash.slice(0, 18)}…`, `reputation ${cRepBefore} → ${cRepAfter}`] });

    // 6b. Casper issues a Cosmos-scoped CAN, agent draws on CosmWasm, repays
    const cosmosCan = ledger.notes.issue_can({
      agent_id: agentId, credit_score: Math.max(agent.credit_score, 80), risk_policy_version: 1,
      target_chain: COSMOS, target_pool: COSMOS_POOL, max_draw: 300_000_000n, asset: "USDC",
    });
    const cosmosDraw = await cosmos.drawCredit({ note: cosmosCan, agent_id: agentId, amount: "150000000" });
    if (cosmosDraw.ok) await casper.drawCredit({ note: cosmosCan, agent_id: agentId, amount: "150000000" });
    const globalOutstanding = Number(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding) / 1e6;
    scenes.push({ scene: "Borrow $150 on Osmosis under the SAME Casper cap", lines: [`CosmWasm lent $150 (tx ${cosmosDraw.tx_hash.slice(0, 14)}…)`, `global outstanding now $${globalOutstanding} across 2 chains`] });

    await cosmos.repayCredit({ agent_id: agentId, amount: "150000000" });
    await casper.repayCredit({ agent_id: agentId, amount: "150000000" });
    scenes.push({ scene: "Repay on Osmosis → Casper releases the shared cap", lines: [`outstanding $${Number(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding) / 1e6}`, `Cosmos vault liquidity $${Number(cosmosVault.availableLiquidity()) / 1e6}`] });

    // 7. THIRD satellite family — Solana (Anchor/SPL). One Casper root governs EVM,
    //    Cosmos and Solana alike: high-throughput execution, same over-borrow guard.
    const SOL = "solana:mainnet";
    const SOL_POOL = "Cred402Vau1tSo1anaCreditPoo1111111111111111";
    const solVault = new SolanaSatelliteVault(SOL, SOL_POOL, ledger.policyPublicKeyHex, 1_000_000_000n, "USDC");
    const solana = new SolanaAdapter(SOL, solVault, () => ledger.clock.now());

    const solCan = ledger.notes.issue_can({
      agent_id: agentId, credit_score: Math.max(agent.credit_score, 80), risk_policy_version: 1,
      target_chain: SOL, target_pool: SOL_POOL, max_draw: 200_000_000n, asset: "USDC",
    });
    const solDraw = await solana.drawCredit({ note: solCan, agent_id: agentId, amount: "120000000" });
    if (solDraw.ok) await casper.drawCredit({ note: solCan, agent_id: agentId, amount: "120000000" });
    scenes.push({ scene: "Borrow $120 on Solana under the SAME Casper cap", lines: [`Anchor program lent $120 (sig ${solDraw.tx_hash.slice(0, 16)}…)`, `global outstanding now $${Number(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding) / 1e6} across 3 chain families`] });

    await solana.repayCredit({ agent_id: agentId, amount: "120000000" });
    await casper.repayCredit({ agent_id: agentId, amount: "120000000" });
    scenes.push({ scene: "Repay on Solana → exposure fully released", lines: [`outstanding $${Number(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding) / 1e6}`, `Solana vault liquidity $${Number(solVault.availableLiquidity()) / 1e6}`] });
    return scenes;
  }

  reset(): void {
    this.economy.watchdog.stop(); // detach the old watchdog from the persistent bus
    this.bus.clearLog();
    this.economy = new Cred402Economy(new Ledger(this.bus, this.clock));
    this.marketplace = new Marketplace(this.ledger);
    this.governanceProposals = new GovernanceProposals(this.ledger, 100, 3600);
    this.attestations = new AttestationGraph(this.ledger);
    this.creditOffers = new CreditOffers(this.ledger, this.economy.credit);
    this.pendingChallenges.clear();
  }
}

let _state: ServerState | null = null;
export function getState(): ServerState {
  if (!_state) _state = new ServerState();
  return _state;
}
