import { Cred402Economy } from "../agents/index.js";
import { cspr } from "../lib/core/units.js";
import { hashObject } from "../lib/core/hash.js";
import type { DisputeType } from "../lib/core/protocol_types.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import type { VerificationLevel } from "../lib/realfi/envelopes.js";
import { buildComplianceReport } from "../lib/services/compliance_report.js";
import { buildPortfolioReport } from "../lib/services/portfolio.js";
import { discoverAgents } from "../lib/services/discovery.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { simulateUnderwriting } from "../lib/services/credit_simulator.js";
import { buildPeerBenchmark } from "../lib/services/peer_benchmark.js";
import { CreditOffers } from "../lib/services/credit_offers.js";
import { buildCreditHistory } from "../lib/services/credit_history.js";
import { buildRiskAlerts } from "../lib/services/risk_alerts.js";
import { buildYieldProjection } from "../lib/services/yield_projection.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { buildOnboardingScorecard } from "../lib/services/onboarding_scorecard.js";
import { buildScoreTrend } from "../lib/services/score_trend.js";
import { buildReputationBreakdown } from "../lib/services/reputation_breakdown.js";
import { buildFleetOverview } from "../lib/services/fleet_overview.js";
import { reviewCreditLine } from "../lib/services/credit_review.js";
import { buildAgentMultichainSummary } from "../lib/services/agent_multichain.js";
import { compareAgents } from "../lib/services/agent_compare.js";
import { buildCategoryAnalytics } from "../lib/services/category_analytics.js";
import { buildReputationMovers } from "../lib/services/reputation_movers.js";
import { buildDisputeStats } from "../lib/services/dispute_stats.js";
import { buildX402Stats } from "../lib/services/x402_stats.js";
import { buildProtocolConfig } from "../lib/services/protocol_config.js";
import { findSimilarAgents } from "../lib/services/similar_agents.js";
import { buildAgentDossier } from "../lib/services/agent_dossier.js";
import { computeSafeDraw } from "../lib/services/safe_draw.js";
import { buildLpDepositPreview } from "../lib/services/lp_deposit_preview.js";
import { buildAgentHealthBadge } from "../lib/services/agent_health.js";
import { computeCreditCost } from "../lib/services/credit_cost.js";
import { ProtocolEconomics as ProtocolEconomicsForCost } from "../lib/core/economics.js";
import { Cred402CreditOracle } from "../lib/services/credit_oracle.js";
import { RiskEngineV2 } from "../lib/services/risk_engine_v2.js";
import { CreditDataCommons } from "../lib/services/credit_data_commons.js";
import { CrossChainReconciler } from "../lib/services/crosschain_reconciliation.js";
import { ServiceVerticals } from "../lib/services/service_verticals.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { ConfidentialScorer } from "../lib/flare/confidential_score.js";
import { PositionEngine } from "../lib/flare/positions.js";
import { CreditKeeper } from "../lib/flare/keeper.js";
import { AutomationEngine, type AutomationDef } from "../lib/flare/automations.js";
import { CreditServiceMarketplace } from "../lib/services/x402_marketplace.js";
import { signPayment } from "../lib/x402/index.js";
import { FAssetsMinter } from "../lib/flare/fassets_mint.js";
import { fxrpToXrp } from "../packages/chain-adapters/src/index.js";
import { AutonomousScheduler } from "../lib/keeperhub/index.js";

/**
 * Cred402 MCP tool registry (p2 §12).
 *
 * Exposes the protocol as MCP tools so any AI agent can operate it naturally:
 * register, earn via x402, build reputation, borrow, dispute. Each tool operates
 * on a shared in-process Cred402Economy (the same ledger simulation the dashboard
 * uses); point it at a live Testnet by swapping the ledger for casper-js-sdk calls.
 */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (args: Record<string, unknown>, econ: Cred402Economy) => unknown | Promise<unknown>;
}

const str = (d: string) => ({ type: "string", description: d });
const num = (d: string) => ({ type: "number", description: d });

/** Parse a whole-FXRP tool argument to 6dp smallest units, or null if invalid. */
function fxrpSmallestUnits(v: unknown): bigint | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return BigInt(Math.round(n * 1e6));
}

function jsonSafe(v: unknown): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}

// One web-of-trust graph per economy instance, so `attest` and `discover_agents`
// share state within an MCP session (mirrors the API's persistent AttestationGraph).
const trustGraphs = new WeakMap<Cred402Economy, AttestationGraph>();
function trustGraph(econ: Cred402Economy): AttestationGraph {
  let g = trustGraphs.get(econ);
  if (!g) {
    g = new AttestationGraph(econ.ledger);
    trustGraphs.set(econ, g);
  }
  return g;
}

// One credit-offer book per economy, so issue/accept share state within a session.
const offerBooks = new WeakMap<Cred402Economy, CreditOffers>();
function creditOffers(econ: Cred402Economy): CreditOffers {
  let o = offerBooks.get(econ);
  if (!o) {
    o = new CreditOffers(econ.ledger, econ.credit);
    offerBooks.set(econ, o);
  }
  return o;
}

// One Flare satellite per economy — Casper-issued CANs → FXRP credit priced by FTSO
// → executed on-chain through KeeperHub. Shares the ledger's policy key + exposure.
const flareSatellites = new WeakMap<Cred402Economy, FlareCreditSatellite>();
function flareSatellite(econ: Cred402Economy): FlareCreditSatellite {
  let s = flareSatellites.get(econ);
  if (!s) {
    s = new FlareCreditSatellite(econ.ledger);
    flareSatellites.set(econ, s);
  }
  return s;
}

// One Flare Confidential Compute scorer per economy.
const confidentialScorers = new WeakMap<Cred402Economy, ConfidentialScorer>();
function confidentialScorer(econ: Cred402Economy): ConfidentialScorer {
  let c = confidentialScorers.get(econ);
  if (!c) {
    c = new ConfidentialScorer();
    confidentialScorers.set(econ, c);
  }
  return c;
}

// One Credit Automation engine per economy, so create/list/tick share state in a session.
const automationEngines = new WeakMap<Cred402Economy, AutomationEngine>();
function automationEngine(econ: Cred402Economy): AutomationEngine {
  let a = automationEngines.get(econ);
  if (!a) {
    a = new AutomationEngine();
    automationEngines.set(econ, a);
  }
  return a;
}

// One x402 credit-service marketplace per economy, so receipts accumulate in a session.
const marketplaces = new WeakMap<Cred402Economy, CreditServiceMarketplace>();
function marketplace(econ: Cred402Economy): CreditServiceMarketplace {
  let m = marketplaces.get(econ);
  if (!m) {
    m = new CreditServiceMarketplace(econ.seller.agent_id, (id, params) => runMcpService(econ, id, params));
    marketplaces.set(econ, m);
  }
  return m;
}
// One FAssets minter per economy, so mint balances persist within a session.
const minters = new WeakMap<Cred402Economy, FAssetsMinter>();
function minter(econ: Cred402Economy): FAssetsMinter {
  let m = minters.get(econ);
  if (!m) {
    m = new FAssetsMinter();
    minters.set(econ, m);
  }
  return m;
}

// One autonomous scheduler per economy (keeper sweep + automation tick jobs).
const schedulers = new WeakMap<Cred402Economy, AutonomousScheduler>();
function scheduler(econ: Cred402Economy): AutonomousScheduler {
  let s = schedulers.get(econ);
  if (!s) {
    s = new AutonomousScheduler();
    s.addJob({
      name: "keeper-sweep",
      interval_sec: 60,
      run: () => new CreditKeeper(flareSatellite(econ), econ.ledger).runFleet(econ.ledger.agents.list().map((a) => a.agent_id)),
    });
    s.addJob({
      name: "automation-tick",
      interval_sec: 30,
      run: () => automationEngine(econ).tick({ satellite: flareSatellite(econ), ledger: econ.ledger }),
    });
    schedulers.set(econ, s);
  }
  return s;
}

async function runMcpService(econ: Cred402Economy, id: string, params: Record<string, unknown>): Promise<unknown> {
  const agentId = String(params.agent_id ?? "");
  switch (id) {
    case "credit-check":
      return jsonSafe(new Cred402CreditOracle(econ.ledger).creditCheck(agentId));
    case "confidential-score": {
      const rs = new RiskEngineV2(econ.ledger).score(agentId);
      if ("error" in rs) return rs;
      return jsonSafe(await confidentialScorer(econ).score(rs.agent_id, rs.features));
    }
    case "position-health": {
      const sat = flareSatellite(econ);
      return jsonSafe(await new PositionEngine(sat.vault, econ.ledger, sat.priceClient, {}, sat.collateral).assess(agentId));
    }
    case "risk-score":
      return jsonSafe(new RiskEngineV2(econ.ledger).score(agentId));
    case "underwrite":
      return jsonSafe(simulateUnderwriting(econ.ledger, { monthly_revenue_cspr: Number(params.monthly_revenue_cspr) }));
    default:
      throw new Error(`unknown service: ${id}`);
  }
}

export const TOOLS: ToolDef[] = [
  {
    name: "cred402.register_agent",
    description: "Register a new autonomous agent with its service type and capabilities.",
    inputSchema: {
      type: "object",
      properties: { agent_id: str("unique agent id"), service_type: str("service category"), capabilities: { type: "array", items: { type: "string" } } },
      required: ["agent_id", "service_type"],
    },
    handler: (a, econ) => {
      const id = String(a.agent_id);
      econ.ledger.agents.register_agent({
        agent_id: id,
        owner_public_key: "01mcp",
        agent_public_key: "01mcp",
        service_type: (a.service_type as never) ?? "monitoring",
      });
      if (Array.isArray(a.capabilities)) econ.ledger.passports.set_profile(id, { capabilities: a.capabilities as string[] });
      return jsonSafe(econ.ledger.buildPassport(id));
    },
  },
  {
    name: "cred402.get_agent_passport",
    description: "Get an agent's read-optimized public trust profile (passport).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(econ.ledger.buildPassport(String(a.agent_id)) ?? { error: "unknown agent" }),
  },
  {
    name: "cred402.get_agent_reputation",
    description: "Get an agent's reputation, accuracy and dispute rate.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => {
      const ag = econ.ledger.agents.get(String(a.agent_id));
      return ag ? jsonSafe({ reputation: ag.reputation_score, accuracy: ag.accuracy_score, dispute_rate: ag.dispute_rate }) : { error: "unknown agent" };
    },
  },
  {
    name: "cred402.get_agent_credit_line",
    description: "Get an agent's credit line (max, drawn, APR, health factor, status).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(econ.ledger.pool.get(String(a.agent_id)) ?? { error: "no credit line" }),
  },
  {
    name: "cred402.request_rwa_evidence",
    description: "Create an RWA verification job (the demo solar farm) needing evidence.",
    inputSchema: { type: "object", properties: { requested_loan_cspr: num("loan size in CSPR") }, required: [] },
    handler: (a, econ) => jsonSafe(econ.buyer.createSolarJob({ requested_loan_cspr: Number(a.requested_loan_cspr ?? 5000) })),
  },
  {
    name: "cred402.submit_rwa_evidence",
    description: "Run the full x402 purchase + evidence submission for one evidence type.",
    inputSchema: { type: "object", properties: { evidence_type: str("e.g. energy_output") }, required: ["evidence_type"] },
    handler: async (a, econ) => {
      const r = await econ.buyer.buyEvidence(econ.seller, "SOLAR-A17", String(a.evidence_type), cspr(0.002));
      return jsonSafe({ report: r.report, receipt_id: r.receipt.receipt_id });
    },
  },
  {
    name: "cred402.record_x402_receipt",
    description: "Inspect recorded x402 receipts (the cash-flow proofs).",
    inputSchema: { type: "object", properties: { agent_id: str("seller agent id") }, required: [] },
    handler: (a, econ) => jsonSafe(a.agent_id ? econ.ledger.receipts.forSeller(String(a.agent_id)) : econ.ledger.receipts.list()),
  },
  {
    name: "cred402.finalize_receipt",
    description: "Finalize a settled receipt so it counts toward credit.",
    inputSchema: { type: "object", properties: { receipt_id: str("receipt id") }, required: ["receipt_id"] },
    handler: (a, econ) => jsonSafe(econ.ledger.receipts.finalize_receipt(String(a.receipt_id))),
  },
  {
    name: "cred402.open_dispute",
    description: "Open a dispute against an agent (bad_evidence, fake_receipt, agent_default, ...).",
    inputSchema: {
      type: "object",
      properties: { dispute_type: str("dispute type"), respondent_agent: str("agent id"), note: str("reason"), receipt_id: str("optional receipt") },
      required: ["dispute_type", "respondent_agent"],
    },
    handler: (a, econ) =>
      jsonSafe(
        econ.ledger.disputes.open({
          dispute_type: (a.dispute_type as DisputeType) ?? "bad_evidence",
          complainant: "mcp.caller",
          respondent_agent: String(a.respondent_agent),
          receipt_id: a.receipt_id ? String(a.receipt_id) : undefined,
          note: String(a.note ?? "opened via MCP"),
          evidence_hash: hashObject({ note: a.note, t: "mcp" }),
        }),
      ),
  },
  {
    name: "cred402.submit_dispute_evidence",
    description: "Add evidence to an open dispute.",
    inputSchema: { type: "object", properties: { dispute_id: str("dispute id"), note: str("evidence note") }, required: ["dispute_id"] },
    handler: (a, econ) => {
      econ.ledger.disputes.submit_evidence(String(a.dispute_id), "mcp.caller", hashObject({ note: a.note }), String(a.note ?? ""));
      return jsonSafe(econ.ledger.disputes.get(String(a.dispute_id)));
    },
  },
  {
    name: "cred402.deposit_credit_pool",
    description: "Deposit liquidity into the agent credit pool.",
    inputSchema: { type: "object", properties: { amount_cspr: num("CSPR to deposit") }, required: ["amount_cspr"] },
    handler: (a, econ) => {
      econ.treasury.depositLiquidity(Number(a.amount_cspr));
      return jsonSafe(econ.ledger.pool.poolState());
    },
  },
  {
    name: "cred402.draw_agent_credit",
    description: "Draw working capital against an agent's credit line.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), amount_cspr: num("CSPR to draw") }, required: ["agent_id", "amount_cspr"] },
    handler: (a, econ) => jsonSafe(econ.treasury.fundDraw(String(a.agent_id), Number(a.amount_cspr))),
  },
  {
    name: "cred402.repay_agent_credit",
    description: "Repay drawn credit (principal + interest).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), amount_cspr: num("CSPR to repay") }, required: ["agent_id", "amount_cspr"] },
    handler: (a, econ) => jsonSafe(econ.treasury.collectRepayment(String(a.agent_id), Number(a.amount_cspr))),
  },
  {
    name: "cred402.watch_protocol_events",
    description: "Return recent protocol events (Casper streaming-events analogue).",
    inputSchema: { type: "object", properties: { since: num("sequence number") }, required: [] },
    handler: (a, econ) => jsonSafe(econ.ledger.bus.since(Number(a.since ?? 0)).slice(-50)),
  },
  {
    name: "cred402.get_risk_policy",
    description: "Get the active risk policy version and governance parameters.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe({ policy_version: econ.ledger.policy.version(), governance: econ.ledger.governance.get() }),
  },
  {
    name: "cred402.explain_credit_score",
    description: "Explain an agent's credit decision with the policy rationale.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => {
      const ag = econ.ledger.agents.get(String(a.agent_id));
      if (!ag) return { error: "unknown agent" };
      return jsonSafe(econ.ledger.policy.evaluate(ag));
    },
  },
  {
    name: "cred402.verify_operator",
    description: "RealFi (p6): record a Stripe-Identity operator verification (hashes only, no PII on-chain).",
    inputSchema: {
      type: "object",
      properties: {
        operator_id: str("operator id"),
        verification_level: str("unverified | email_verified | business_verified | regulated_entity"),
        jurisdiction: str("ISO 3166 alpha-2"),
        verification_reference: str("raw KYB reference (hashed locally)"),
      },
      required: ["operator_id"],
    },
    handler: (a, econ) => {
      const r = new RealFiBridge(econ.ledger).verifyOperator({
        operator_id: String(a.operator_id),
        verification_level: (a.verification_level as VerificationLevel) ?? "business_verified",
        jurisdiction: String(a.jurisdiction ?? "US"),
        verification_reference: String(a.verification_reference ?? `idv_${a.operator_id}`),
      });
      return jsonSafe({ attestation_hash: r.attestation_hash, record: r.record });
    },
  },
  {
    name: "cred402.record_fiat_receipt",
    description: "RealFi (p6): record a Stripe fiat receipt for an agent (privacy-preserving Fiat Receipt Envelope).",
    inputSchema: {
      type: "object",
      properties: {
        seller_agent: str("seller agent id"),
        operator_id: str("operator id"),
        amount: str("decimal amount, e.g. 100.00"),
        currency: str("ISO 4217, e.g. USD"),
        service_type: str("service category"),
      },
      required: ["seller_agent", "operator_id"],
    },
    handler: (a, econ) => {
      const r = new RealFiBridge(econ.ledger).recordFiatReceipt({
        provider_event_id: `evt_${econ.ledger.fiatReceipts.list().length}`,
        provider_receipt_id: `ch_${econ.ledger.fiatReceipts.list().length}`,
        payer_type: "enterprise_customer",
        seller_agent: String(a.seller_agent),
        operator_id: String(a.operator_id),
        amount: String(a.amount ?? "100.00"),
        currency: String(a.currency ?? "USD"),
        service_type: String(a.service_type ?? "rwa.weather_risk"),
        request_hash: "0xreq",
        result_hash: "0xres",
      });
      return jsonSafe({ receipt_id: r.receipt_id, record: r.record });
    },
  },
  {
    name: "cred402.get_realfi_profile",
    description: "RealFi (p6): the RealFi profile for an agent/operator — fiat receipts, operator verification, attestations.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), operator_id: str("operator id") }, required: [] },
    handler: (a, econ) => {
      const agentId = a.agent_id ? String(a.agent_id) : undefined;
      const operatorId = a.operator_id ? String(a.operator_id) : undefined;
      return jsonSafe({
        operator_verified: operatorId ? econ.ledger.operators.is_verified(operatorId) : false,
        operator_verification: operatorId ? econ.ledger.operators.get_operator_verification(operatorId) : undefined,
        fiat_receipts: agentId ? econ.ledger.fiatReceipts.forSeller(agentId) : econ.ledger.fiatReceipts.list(),
        attestations: operatorId ? econ.ledger.realfi.forSubject(operatorId) : econ.ledger.realfi.list(),
      });
    },
  },
  {
    name: "cred402.discover_agents",
    description: "Discover and rank agents by a composite score (reputation + creditworthiness + web-of-trust + tier − fraud). Filter by service_type/min_reputation.",
    inputSchema: {
      type: "object",
      properties: {
        service_type: str("filter by service type"),
        min_reputation: num("minimum reputation"),
        min_score: num("minimum discovery score"),
        limit: num("max results (default 50)"),
      },
      required: [],
    },
    handler: (a, econ) =>
      jsonSafe(
        discoverAgents(econ.ledger, trustGraph(econ), {
          service_type: a.service_type ? String(a.service_type) : undefined,
          min_reputation: a.min_reputation !== undefined ? Number(a.min_reputation) : undefined,
          min_score: a.min_score !== undefined ? Number(a.min_score) : undefined,
          limit: a.limit !== undefined ? Number(a.limit) : undefined,
        }),
      ),
  },
  {
    name: "cred402.attest_agent",
    description: "Issue a trust attestation (vouch) from one agent to another. Attester needs reputation ≥ 60; the boost is anti-Sybil capped.",
    inputSchema: {
      type: "object",
      properties: { from: str("attester agent id"), to: str("target agent id"), note: str("optional note") },
      required: ["from", "to"],
    },
    handler: (a, econ) => {
      try {
        return jsonSafe(trustGraph(econ).attest(String(a.from), String(a.to), String(a.note ?? "")));
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },
  {
    name: "cred402.compliance_report",
    description: "Per-jurisdiction compliance report: operators grouped by jurisdiction with KYB coverage and sanctions exposure.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildComplianceReport(econ.ledger)),
  },
  {
    name: "cred402.portfolio_report",
    description: "LP-facing portfolio & concentration-risk report: utilization, exposure breakdowns, and a Herfindahl (HHI) concentration index.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildPortfolioReport(econ.ledger)),
  },
  {
    name: "cred402.simulate_credit",
    description: "Read-only 'what-if' underwriting preview: estimate the credit line, rate and reason codes for hypothetical agent signals without registering an agent.",
    inputSchema: {
      type: "object",
      properties: {
        monthly_revenue_cspr: num("30-day x402 revenue in CSPR"),
        stake_cspr: num("staked CSPR"),
        reputation: num("0..100 reputation"),
        accuracy: num("0..100 evidence accuracy"),
        dispute_rate: num("0..1 dispute fraction"),
        jobs_completed: num("lifetime jobs"),
        service_type: str("service category"),
      },
      required: ["monthly_revenue_cspr"],
    },
    handler: (a, econ) =>
      jsonSafe(
        simulateUnderwriting(econ.ledger, {
          monthly_revenue_cspr: Number(a.monthly_revenue_cspr ?? 0),
          stake_cspr: a.stake_cspr !== undefined ? Number(a.stake_cspr) : undefined,
          reputation: a.reputation !== undefined ? Number(a.reputation) : undefined,
          accuracy: a.accuracy !== undefined ? Number(a.accuracy) : undefined,
          dispute_rate: a.dispute_rate !== undefined ? Number(a.dispute_rate) : undefined,
          jobs_completed: a.jobs_completed !== undefined ? Number(a.jobs_completed) : undefined,
          service_type: a.service_type ? String(a.service_type) : undefined,
        }),
      ),
  },
  {
    name: "cred402.peer_benchmark",
    description: "Benchmark an agent against its service-type cohort: percentile + rank for reputation, credit score, revenue and fraud (lower is better).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildPeerBenchmark(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.issue_credit_offer",
    description: "Issue a time-bounded credit pre-approval offer for an agent, with terms from the live underwriter (does not open a line until accepted).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), ttl_seconds: num("acceptance deadline seconds") }, required: ["agent_id"] },
    handler: (a, econ) =>
      jsonSafe(creditOffers(econ).issue(String(a.agent_id), { ttl_seconds: a.ttl_seconds !== undefined ? Number(a.ttl_seconds) : undefined })),
  },
  {
    name: "cred402.accept_credit_offer",
    description: "Accept a pending, unexpired credit offer — opens a credit line at the locked terms.",
    inputSchema: { type: "object", properties: { offer_id: str("offer id") }, required: ["offer_id"] },
    handler: (a, econ) => jsonSafe(creditOffers(econ).accept(String(a.offer_id))),
  },
  {
    name: "cred402.credit_history",
    description: "The agent's chronological credit file: every on-chain event concerning it, categorized (identity/revenue/credit/dispute/reputation/crosschain).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildCreditHistory(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.risk_alerts",
    description: "Always-on risk monitoring sweep: severity-ranked alerts for concentration, overdue lines, fraud exposure on open credit, frozen/defaulted lines and liquidity stress.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildRiskAlerts(econ.ledger)),
  },
  {
    name: "cred402.yield_projection",
    description: "LP forward yield projection over 30/90/365 days: gross interest, LP share after the protocol spread, expected loss, and projected net APY.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildYieldProjection(econ.ledger, new ProtocolEconomics())),
  },
  {
    name: "cred402.onboarding_readiness",
    description: "Agent onboarding readiness scorecard: a pass/fail checklist of the gates required to qualify for credit, with guidance and an overall readiness percentage.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildOnboardingScorecard(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.reputation_breakdown",
    description: "Per-dimension breakdown of an agent's composite reputation (quality, timeliness, dispute, revenue, repayment, expertise) with each dimension's value, weight and contribution — actionable feedback.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildReputationBreakdown(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.score_trend",
    description: "The agent's credit-score and reputation trajectory over time (current, net change, and points), reconstructed from the event log.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildScoreTrend(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.fleet_overview",
    description: "Operator fleet dashboard: readiness + discovery standing + current credit line for a list of agents in one call. Unknown ids are flagged.",
    inputSchema: {
      type: "object",
      properties: { agent_ids: { type: "array", items: { type: "string" }, description: "agent ids" } },
      required: ["agent_ids"],
    },
    handler: (a, econ) => jsonSafe(buildFleetOverview(econ.ledger, trustGraph(econ), (a.agent_ids as string[]) ?? [])),
  },
  {
    name: "cred402.review_credit_line",
    description: "Review an existing credit line: ratchet the limit UP if the agent now qualifies for more; hold otherwise. Never auto-reduces extended credit.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(reviewCreditLine(econ.ledger, econ.credit, String(a.agent_id))),
  },
  {
    name: "cred402.agent_multichain",
    description: "An agent's cross-chain footprint: address bindings, Casper-anchored external receipts, Credit Authorization Notes per satellite chain, and its shared global exposure.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildAgentMultichainSummary(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.credit_cost",
    description: "Itemize the full cost of a specific draw against an agent's line: upfront origination fee, prorated interest over the term, total repayment and effective all-in cost.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), draw_cspr: num("draw amount in CSPR") }, required: ["agent_id", "draw_cspr"] },
    handler: (a, econ) => jsonSafe(computeCreditCost(econ.ledger, new ProtocolEconomicsForCost(), String(a.agent_id), Number(a.draw_cspr))),
  },
  {
    name: "cred402.lp_deposit_preview",
    description: "Preview an LP deposit: resulting pool share, utilization, and projected annual yield on the deposit — without moving funds.",
    inputSchema: { type: "object", properties: { deposit_cspr: num("deposit amount in CSPR") }, required: ["deposit_cspr"] },
    handler: (a, econ) => jsonSafe(buildLpDepositPreview(econ.ledger, new ProtocolEconomicsForCost(), Number(a.deposit_cspr))),
  },
  {
    name: "cred402.safe_draw",
    description: "Advise the largest additional draw that keeps an agent's credit line at or above a target health factor (default 1.5x), bounded by line headroom and pool liquidity.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), target_hf_bps: num("target health factor in bps (default 15000 = 1.5x)") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(computeSafeDraw(econ.ledger, String(a.agent_id), a.target_hf_bps !== undefined ? Number(a.target_hf_bps) : undefined)),
  },
  {
    name: "cred402.agent_dossier",
    description: "One-call integrator snapshot for an agent: tier, health, readiness, peer-benchmark percentile, reputation momentum, credit line and operator — the bureau view bundled.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildAgentDossier(econ.ledger, trustGraph(econ), String(a.agent_id))),
  },
  {
    name: "cred402.similar_agents",
    description: "Comparable alternative agents for a given agent ('you might also consider'): same service category, ranked by closeness in standing and overall strength.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), limit: num("max alternatives") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(findSimilarAgents(econ.ledger, trustGraph(econ), String(a.agent_id), a.limit !== undefined ? Number(a.limit) : undefined)),
  },
  {
    name: "cred402.agent_health",
    description: "A glanceable green/amber/red health verdict for an agent (worst-of reputation, fraud risk, open disputes and credit-line status) with a composite score and the driving factors.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildAgentHealthBadge(econ.ledger, String(a.agent_id))),
  },
  {
    name: "cred402.protocol_config",
    description: "The self-documenting protocol rulebook: fee schedule, credit gates (min reputation, max exposure), and the reputation-tier perk table.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildProtocolConfig(econ.ledger)),
  },
  {
    name: "cred402.x402_stats",
    description: "x402 receipt-network analytics (Product B): total volume, settlement status breakdown, finalization rate, top sellers/payers, and per-service volume.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildX402Stats(econ.ledger)),
  },
  {
    name: "cred402.dispute_stats",
    description: "Protocol-level dispute intelligence: totals, open/resolved, outcomes by verdict and type, total slashed, resolution and agent-loss rates, and the most-disputed agent.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildDisputeStats(econ.ledger)),
  },
  {
    name: "cred402.reputation_movers",
    description: "Biggest reputation gainers and losers (net change reconstructed from the event log) — momentum, not just level.",
    inputSchema: { type: "object", properties: { limit: num("max per list (default 5)") }, required: [] },
    handler: (a, econ) => jsonSafe(buildReputationMovers(econ.ledger, a.limit !== undefined ? Number(a.limit) : undefined)),
  },
  {
    name: "cred402.category_analytics",
    description: "Market intelligence by service category: per-category agent supply, average reputation/credit, total receipts and revenue, and the top earner.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(buildCategoryAnalytics(econ.ledger)),
  },
  {
    name: "cred402.compare_agents",
    description: "Side-by-side comparison of two agents across discovery score, reputation, credit, trust, revenue, fraud and dispute rate, with a per-metric and overall winner.",
    inputSchema: { type: "object", properties: { a: str("first agent id"), b: str("second agent id") }, required: ["a", "b"] },
    handler: (a, econ) => jsonSafe(compareAgents(econ.ledger, trustGraph(econ), String(a.a), String(a.b))),
  },
  {
    name: "cred402.review_all_credit_lines",
    description: "Periodic portfolio maintenance: re-underwrite every active credit line (ratchet-up only) and summarize increased/held/ineligible.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => {
      const active = econ.ledger.pool.list().filter((l) => l.status === "active");
      const results = active.map((l) => reviewCreditLine(econ.ledger, econ.credit, l.agent_id));
      const ok = results.filter((r) => !("error" in r)) as Array<{ action: string }>;
      return jsonSafe({
        reviewed: ok.length,
        increased: ok.filter((r) => r.action === "increased").length,
        held: ok.filter((r) => r.action === "held").length,
        ineligible: ok.filter((r) => r.action === "ineligible").length,
        results,
      });
    },
  },
  {
    name: "cred402.credit_check",
    description: "Credit-as-a-service ('Cred402 Inside', p3): the creditworthiness answer other x402 protocols query — eligibility, recommended limit, score, interest rate, and risk flags, policy-version stamped.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(new Cred402CreditOracle(econ.ledger).creditCheck(String(a.agent_id))),
  },
  {
    name: "cred402.risk_score_v2",
    description: "ML risk-engine v2 (p7): learned probability-of-default plus the v1 rules score and a blended score, with the normalized feature vector behind it.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(new RiskEngineV2(econ.ledger).score(String(a.agent_id))),
  },
  {
    name: "cred402.credit_data_commons",
    description: "Anonymized, k-anonymous public credit-data snapshot (p6 data moat): per-category and per-tier aggregates, pool utilization, and dispute slash rate. No agent ids.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(new CreditDataCommons(econ.ledger).snapshot()),
  },
  {
    name: "cred402.agent_exposure",
    description: "Omnichain credit reconciliation (p5): an agent's Casper-rooted global exposure, satellite consistency, and remaining global headroom across all chains.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => {
      const recon = new CrossChainReconciler(econ.ledger);
      const id = String(a.agent_id);
      return jsonSafe({ ...recon.reconcile(id), global_headroom_motes: recon.globalHeadroom(id).toString() });
    },
  },
  {
    name: "cred402.service_verticals",
    description: "Service-vertical underwriting profiles (p10): advance rate, volatility haircut, settlement horizon, and qualification gates per credit vertical (compute/inference/data/rwa/…).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: () => jsonSafe(new ServiceVerticals().list()),
  },
  // ── Flare satellite (interoperable FXRP credit) + KeeperHub execution ──────
  {
    name: "cred402.flare_info",
    description: "Flare satellite status: network (Coston2/Songbird/Flare), FXRP pool + liquidity, and whether the real FTSO price feed and real KeeperHub execution are live.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(flareSatellite(econ).info()),
  },
  {
    name: "cred402.flare_xrp_price",
    description: "Live XRP/USD price from Flare's FTSO oracle (falls back to a deterministic reference with no RPC). Used to value FXRP credit draws in USD.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_a, econ) => jsonSafe(await flareSatellite(econ).xrpUsd()),
  },
  {
    name: "cred402.flare_draw_fxrp",
    description: "Draw working capital in the interoperable FAsset FXRP: Casper signs a USD-limited Credit Authorization Note, the Flare vault lends FXRP priced by FTSO, and KeeperHub executes the on-chain transaction (simulate → smart gas w/ backoff → private routing → audit).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), amount_fxrp: num("FXRP to draw (whole FXRP)") }, required: ["agent_id", "amount_fxrp"] },
    handler: async (a, econ) => {
      const amount = fxrpSmallestUnits(a.amount_fxrp);
      if (amount === null) return { error: "amount_fxrp must be a positive finite number" };
      return jsonSafe(await flareSatellite(econ).draw(String(a.agent_id), amount));
    },
  },
  {
    name: "cred402.flare_repay_fxrp",
    description: "Repay FXRP credit on the Flare satellite; the repayment is also executed through KeeperHub and released against the agent's Casper-rooted global exposure.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), amount_fxrp: num("FXRP to repay (whole FXRP)") }, required: ["agent_id", "amount_fxrp"] },
    handler: async (a, econ) => {
      const amount = fxrpSmallestUnits(a.amount_fxrp);
      if (amount === null) return { error: "amount_fxrp must be a positive finite number" };
      return jsonSafe(await flareSatellite(econ).repay(String(a.agent_id), amount));
    },
  },
  {
    name: "cred402.keeperhub_reliability",
    description: "KeeperHub reliability summary for this session: executions, confirmations, private-routed + sponsored counts, average gas-backoff attempts, total gas, and settlement protocol (x402/MPP) breakdown.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(flareSatellite(econ).reliability()),
  },
  {
    name: "cred402.keeperhub_audit",
    description: "KeeperHub audit trail: per-execution record of trigger, simulation result, submitted transaction, gas used, payment rail, private routing, and outcome. Optionally filter by agent.",
    inputSchema: { type: "object", properties: { agent_id: str("optional agent id filter") }, required: [] },
    handler: (a, econ) => jsonSafe(flareSatellite(econ).auditTrail(a.agent_id ? String(a.agent_id) : undefined)),
  },
  {
    name: "cred402.confidential_score",
    description: "Score an agent's creditworthiness inside Flare Confidential Compute (TEE): the raw cash-flow features stay private in the enclave; only an attested score + input/model commitments are returned. Verifiable without revealing the inputs.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: async (a, econ) => {
      const rs = new RiskEngineV2(econ.ledger).score(String(a.agent_id));
      if ("error" in rs) return rs;
      return jsonSafe(await confidentialScorer(econ).score(rs.agent_id, rs.features));
    },
  },
  // ── FTSO position health + Autonomous Credit Keeper ───────────────────────
  {
    name: "cred402.flare_position",
    description: "FTSO position health for an agent's FXRP debt: USD value marked to the live FTSO XRP/USD price, health factor vs the USD credit cap, price-risk drift, status, and the FXRP deleverage needed to cure a margin call. Pass price_usd to stress-test at a hypothetical XRP price.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), price_usd: num("optional what-if XRP/USD price") }, required: ["agent_id"] },
    handler: async (a, econ) => {
      const sat = flareSatellite(econ);
      const engine = new PositionEngine(sat.vault, econ.ledger, sat.priceClient, {}, sat.collateral);
      const priceOverride = a.price_usd !== undefined ? Number(a.price_usd) : undefined;
      return jsonSafe(await engine.assess(String(a.agent_id), { priceOverride }));
    },
  },
  {
    name: "cred402.deposit_collateral",
    description: "Post FTSO-priced collateral (USDC/BTC/ETH/XRP/FLR) to expand an agent's borrowing power. Each asset is marked to its live FTSO feed and discounted by an LTV haircut; the resulting borrowing power is added to the agent's reputation cap in its position health.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), symbol: str("USDC | BTC | ETH | XRP | FLR"), amount: num("whole units to deposit") }, required: ["agent_id", "symbol", "amount"] },
    handler: async (a, econ) => {
      if (!econ.ledger.agents.get(String(a.agent_id))) return { error: `unknown agent: ${a.agent_id}` };
      const sat = flareSatellite(econ);
      try {
        const res = sat.collateral.deposit(String(a.agent_id), String(a.symbol), Number(a.amount));
        return jsonSafe({ ...res, valuation: await sat.collateral.valueUsd(String(a.agent_id)) });
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },
  {
    name: "cred402.collateral_value",
    description: "Value an agent's posted collateral basket in USD via FTSO, with per-asset LTV haircuts, plus the total borrowing power it contributes.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: async (a, econ) => jsonSafe(await flareSatellite(econ).collateral.valueUsd(String(a.agent_id))),
  },
  // ── FAssets: mint FXRP from attested XRP → collateralize ───────────────────
  {
    name: "cred402.mint_fxrp",
    description: "Mint the FAsset FXRP from XRP: reserve minting, FDC-attest the XRPL payment, and execute minting 1:1. Set collateralize=true to immediately post the minted FXRP as FTSO-priced collateral, expanding the agent's borrowing power (bring XRP → borrow).",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), xrp: num("XRP to mint into FXRP"), collateralize: { type: "boolean", description: "post the minted FXRP as collateral" } }, required: ["agent_id", "xrp"] },
    handler: async (a, econ) => {
      const xrp = Number(a.xrp);
      if (!Number.isFinite(xrp) || xrp <= 0) return { error: "xrp must be a positive finite number" };
      const mint = await minter(econ).mint(String(a.agent_id), BigInt(Math.round(xrp * 1e6)));
      if (a.collateralize) {
        const sat = flareSatellite(econ);
        sat.collateral.deposit(String(a.agent_id), "XRP", fxrpToXrp(BigInt(mint.fxrp_minted)));
        minter(econ).debit(String(a.agent_id), BigInt(mint.fxrp_minted)); // FXRP moves wallet → collateral
        return jsonSafe({ mint, valuation: await sat.collateral.valueUsd(String(a.agent_id)) });
      }
      return jsonSafe(mint);
    },
  },
  {
    name: "cred402.fassets_status",
    description: "FAssets status for an agent: FXRP balance, minting reservations, circulating FXRP supply, and whether the real FDC attestation path is live.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => {
      const m = minter(econ);
      return jsonSafe({ agent_id: String(a.agent_id), fxrp_balance: fxrpToXrp(m.balanceOf(String(a.agent_id))), reservations: m.reservationsFor(String(a.agent_id)), total_supply: fxrpToXrp(m.totalSupply()), fdc_live: m.liveFdc });
    },
  },
  {
    name: "cred402.redeem_fxrp",
    description: "Redeem FXRP back to underlying XRP: burns FXRP and opens an XRPL redemption ticket.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id"), fxrp: num("FXRP to redeem") }, required: ["agent_id", "fxrp"] },
    handler: (a, econ) => {
      const fxrp = Number(a.fxrp);
      if (!Number.isFinite(fxrp) || fxrp <= 0) return { error: "fxrp must be a positive finite number" };
      try {
        return jsonSafe(minter(econ).redeem(String(a.agent_id), BigInt(Math.round(fxrp * 1e6))));
      } catch (err) {
        return { error: (err as Error).message };
      }
    },
  },
  {
    name: "cred402.keeper_evaluate",
    description: "Autonomous Credit Keeper — evaluate ONLY (no execution): what protective action the keeper would take for an agent given its FTSO-priced position (deleverage on a margin call, else none), with the reason.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: async (a, econ) => jsonSafe(await new CreditKeeper(flareSatellite(econ), econ.ledger).evaluate(String(a.agent_id))),
  },
  {
    name: "cred402.keeper_run",
    description: "Autonomous Credit Keeper — check then EXECUTE: if the agent's FTSO position is in a margin call, autonomously deleverage it through KeeperHub (simulate → smart gas → private routing → audit). Only ever repays existing FXRP debt; safe to run unattended.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: async (a, econ) => jsonSafe(await new CreditKeeper(flareSatellite(econ), econ.ledger).run(String(a.agent_id))),
  },
  {
    name: "cred402.keeper_run_fleet",
    description: "Run the Autonomous Credit Keeper across every registered agent: per-agent decisions + executions and a rollup (evaluated, actioned, executed, total FXRP deleveraged, status breakdown).",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_a, econ) => {
      const ids = econ.ledger.agents.list().map((ag) => ag.agent_id);
      return jsonSafe(await new CreditKeeper(flareSatellite(econ), econ.ledger).runFleet(ids));
    },
  },
  // ── Credit Automations — declarative price/health/schedule credit rules ────
  {
    name: "cred402.create_automation",
    description: "Create a set-and-forget credit automation: a trigger (price_below/price_above {price}, health_below {threshold}, or schedule {every_seconds}) → an action (deleverage {target_hf}, repay {amount_fxrp}, or notify). Registered as a KeeperHub workflow when a real key is set; executed reliably via KeeperHub on tick.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: str("agent id"),
        name: str("automation name"),
        trigger_kind: str("price_below | price_above | health_below | schedule"),
        price: num("XRP/USD threshold (price_* triggers)"),
        threshold: num("health-factor threshold (health_below)"),
        every_seconds: num("interval seconds (schedule)"),
        action_kind: str("deleverage | repay | notify"),
        target_hf: num("target health factor (deleverage), default 2.0"),
        amount_fxrp: num("FXRP to repay (repay action)"),
      },
      required: ["agent_id", "name", "trigger_kind", "action_kind"],
    },
    handler: async (a, econ) => {
      const def = buildAutomationDef(a);
      if ("error" in def) return def;
      return jsonSafe(await automationEngine(econ).register(def));
    },
  },
  {
    name: "cred402.list_automations",
    description: "List credit automations (optionally for one agent): trigger, action, enabled, fire count, last fired, and KeeperHub workflow id.",
    inputSchema: { type: "object", properties: { agent_id: str("optional agent id filter") }, required: [] },
    handler: (a, econ) => jsonSafe(automationEngine(econ).list(a.agent_id ? String(a.agent_id) : undefined)),
  },
  {
    name: "cred402.tick_automations",
    description: "Evaluate every enabled automation against the live FTSO price + position health and EXECUTE the ones whose trigger is due (deleverage/repay via KeeperHub). Returns one run record per fired automation.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_a, econ) => jsonSafe(await automationEngine(econ).tick({ satellite: flareSatellite(econ), ledger: econ.ledger })),
  },
  {
    name: "cred402.remove_automation",
    description: "Delete a credit automation by id.",
    inputSchema: { type: "object", properties: { id: str("automation id") }, required: ["id"] },
    handler: (a, econ) => jsonSafe({ removed: automationEngine(econ).remove(String(a.id)) }),
  },
  // ── x402 Credit-Service Marketplace — pay-per-call credit intelligence ─────
  {
    name: "cred402.list_services",
    description: "Discover Cred402's credit services sold over x402: credit checks, TEE-attested confidential scores, FTSO position health, ML risk scores, underwriting simulations — each with its per-call price, plus live call/revenue counters.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe({ services: marketplace(econ).listings(), stats: marketplace(econ).stats() }),
  },
  {
    name: "cred402.buy_service",
    description: "Buy a credit service over x402 end to end: fetch the 402 challenge, sign the PaymentAuthorization with a buyer agent's key, and receive the result + receipt. The paid receipt becomes Cred402's own on-chain revenue.",
    inputSchema: {
      type: "object",
      properties: { service_id: str("credit-check | confidential-score | position-health | risk-score | underwrite"), agent_id: str("subject agent (for agent-scoped services)"), monthly_revenue_cspr: num("monthly revenue (underwrite only)") },
      required: ["service_id"],
    },
    handler: async (a, econ) => {
      const m = marketplace(econ);
      const serviceId = String(a.service_id);
      const params: Record<string, unknown> = {
        agent_id: a.agent_id ? String(a.agent_id) : econ.seller.agent_id,
        monthly_revenue_cspr: a.monthly_revenue_cspr ?? 120,
      };
      const challenged = await m.call(serviceId, undefined, params);
      if (challenged.kind !== "challenge") return jsonSafe(challenged);
      const challenge = (challenged.body as { challenge: Parameters<typeof signPayment>[0]["challenge"] }).challenge;
      const { header } = signPayment({
        challenge,
        payer_agent: econ.buyer.agent_id,
        payer_public_key: econ.buyer.publicKeyHex,
        payer_private_pem: econ.buyer.keys.privatePem,
      });
      const paid = await m.call(serviceId, header, params);
      return jsonSafe({ challenge, paid });
    },
  },
  // ── Autonomous scheduler (KeeperHub cron) ──────────────────────────────────
  {
    name: "cred402.scheduler_status",
    description: "Status of the autonomous scheduler: its jobs (keeper fleet sweep + automation tick), their intervals, whether it is running, and the recent run history. Models KeeperHub's scheduled-workflow/cron surface.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: (_a, econ) => jsonSafe(scheduler(econ).status()),
  },
  {
    name: "cred402.scheduler_tick",
    description: "Run one scheduler tick now: execute any due jobs (protective keeper deleverages across the fleet + due credit automations) through KeeperHub. Returns the runs that fired.",
    inputSchema: { type: "object", properties: {}, required: [] },
    handler: async (_a, econ) => jsonSafe({ runs: await scheduler(econ).tick(), status: scheduler(econ).status() }),
  },
];

/** Build a validated AutomationDef from flat MCP tool arguments. */
function buildAutomationDef(a: Record<string, unknown>): AutomationDef | { error: string } {
  const triggerKind = String(a.trigger_kind);
  let trigger: AutomationDef["trigger"];
  if (triggerKind === "price_below" || triggerKind === "price_above") {
    const price = Number(a.price);
    if (!Number.isFinite(price) || price <= 0) return { error: `${triggerKind} requires a positive 'price'` };
    trigger = { kind: triggerKind, price };
  } else if (triggerKind === "health_below") {
    const threshold = Number(a.threshold);
    if (!Number.isFinite(threshold) || threshold <= 0) return { error: "health_below requires a positive 'threshold'" };
    trigger = { kind: "health_below", threshold };
  } else if (triggerKind === "schedule") {
    const every = Number(a.every_seconds);
    if (!Number.isFinite(every) || every < 1) return { error: "schedule requires 'every_seconds' >= 1" };
    trigger = { kind: "schedule", every_seconds: every };
  } else {
    return { error: `unknown trigger_kind: ${triggerKind}` };
  }

  const actionKind = String(a.action_kind);
  let action: AutomationDef["action"];
  if (actionKind === "deleverage") {
    action = { kind: "deleverage", target_hf: a.target_hf !== undefined ? Number(a.target_hf) : undefined };
  } else if (actionKind === "repay") {
    const amount = Number(a.amount_fxrp);
    if (!Number.isFinite(amount) || amount <= 0) return { error: "repay requires a positive 'amount_fxrp'" };
    action = { kind: "repay", amount_fxrp: amount };
  } else if (actionKind === "notify") {
    action = { kind: "notify" };
  } else {
    return { error: `unknown action_kind: ${actionKind}` };
  }

  return { agent_id: String(a.agent_id), name: String(a.name), trigger, action };
}

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));
