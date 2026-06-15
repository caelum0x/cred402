import { Cred402Economy } from "../agents/index.js";
import { cspr } from "../lib/core/units.js";
import { hashObject } from "../lib/core/hash.js";
import type { DisputeType } from "../lib/core/protocol_types.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import type { VerificationLevel } from "../lib/realfi/envelopes.js";

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
];

export const TOOL_INDEX = new Map(TOOLS.map((t) => [t.name, t]));
