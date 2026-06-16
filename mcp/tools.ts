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
import { buildFleetOverview } from "../lib/services/fleet_overview.js";
import { reviewCreditLine } from "../lib/services/credit_review.js";
import { buildAgentMultichainSummary } from "../lib/services/agent_multichain.js";
import { compareAgents } from "../lib/services/agent_compare.js";
import { buildCategoryAnalytics } from "../lib/services/category_analytics.js";
import { buildReputationMovers } from "../lib/services/reputation_movers.js";
import { buildDisputeStats } from "../lib/services/dispute_stats.js";
import { buildX402Stats } from "../lib/services/x402_stats.js";
import { buildAgentHealthBadge } from "../lib/services/agent_health.js";
import { computeCreditCost } from "../lib/services/credit_cost.js";
import { ProtocolEconomics as ProtocolEconomicsForCost } from "../lib/core/economics.js";

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
    name: "cred402.agent_health",
    description: "A glanceable green/amber/red health verdict for an agent (worst-of reputation, fraud risk, open disputes and credit-line status) with a composite score and the driving factors.",
    inputSchema: { type: "object", properties: { agent_id: str("agent id") }, required: ["agent_id"] },
    handler: (a, econ) => jsonSafe(buildAgentHealthBadge(econ.ledger, String(a.agent_id))),
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
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));
