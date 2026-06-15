/**
 * Protocol-layer types introduced by the Cred402 production blueprint (p2):
 * Agent Passport, RWA Asset Registry, Reputation Engine, Dispute Court,
 * Slashing Vault and Governance.
 */

// ---------------------------------------------------------------------------
// RWAAssetRegistry (p2 §6.4)
// ---------------------------------------------------------------------------

export type AssetType =
  | "solar_receivable"
  | "trade_invoice"
  | "warehouse_inventory"
  | "shipping_receivable"
  | "real_estate_cashflow"
  | "carbon_credit"
  | "insurance_claim"
  | "equipment_lease"
  | "treasury_bill_wrapper";

export type AssetStatus = "draft" | "active" | "suspended" | "settled";

export interface RwaAsset {
  rwa_id: string;
  asset_type: AssetType;
  issuer: string;
  jurisdiction_code: string;
  metadata_hash: string;
  document_bundle_hash: string;
  status: AssetStatus;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// ReputationEngine (p2 §6.6) — multi-dimensional, basis-point math
// ---------------------------------------------------------------------------

export interface ReputationDimensions {
  quality_score: number; // 0..100
  timeliness_score: number;
  dispute_score: number;
  revenue_score: number;
  repayment_score: number;
  category_expertise_score: number;
  collusion_penalty: number; // subtracted
}

// ---------------------------------------------------------------------------
// AgentPassport (p2 §6.2) — read-optimized public profile
// ---------------------------------------------------------------------------

export interface AgentPassport {
  agent_id: string;
  service_type: string;
  operator: string;
  stake: bigint;
  reputation_score: number;
  credit_score: number;
  credit_limit: bigint;
  outstanding_debt: bigint;
  total_receipts: number;
  total_revenue: bigint;
  dispute_rate: number;
  capabilities: string[];
  spending_limit: bigint;
  last_active_at: number;
  risk_flags: string[];
}

// ---------------------------------------------------------------------------
// DisputeCourt (p2 §6.9)
// ---------------------------------------------------------------------------

export type DisputeType =
  | "bad_evidence"
  | "fake_receipt"
  | "non_delivery"
  | "payment_reversal"
  | "agent_default"
  | "collusion"
  | "oracle_manipulation"
  | "metadata_fraud";

export type DisputeStatus =
  | "opened"
  | "evidence_period"
  | "under_review"
  | "verdict_pending"
  | "resolved"
  | "closed";

export type Verdict = "agent_wins" | "agent_loses" | "partial_fault" | "inconclusive" | "malicious_dispute";

export interface DisputeEvidence {
  submitter: string;
  evidence_hash: string;
  note: string;
  timestamp: number;
}

export interface Dispute {
  dispute_id: string;
  dispute_type: DisputeType;
  complainant: string;
  respondent_agent: string;
  receipt_id?: string;
  rwa_id?: string;
  status: DisputeStatus;
  evidence: DisputeEvidence[];
  verdict?: Verdict;
  slash_amount: bigint;
  rationale: string[];
  opened_at: number;
  resolved_at?: number;
}

// ---------------------------------------------------------------------------
// SlashingVault (p2 §6.10)
// ---------------------------------------------------------------------------

export type SlashDestination = "victim_reimbursement" | "insurance_reserve" | "protocol_treasury" | "burn";

export interface SlashRecord {
  slash_id: string;
  agent_id: string;
  amount: bigint;
  reason: string;
  dispute_id?: string;
  distribution: Record<SlashDestination, bigint>;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Governance (p2 §6.11)
// ---------------------------------------------------------------------------

export interface GovernanceParams {
  protocol_fee_bps: number;
  origination_fee_bps: number;
  min_reputation_to_draw: number;
  max_agent_exposure: bigint;
  dispute_window_seconds: number;
  paused_credit_draws: boolean;
  paused_registrations: boolean;
  paused_receipt_finalization: boolean;
}

export interface ParameterChange {
  key: string;
  previous: string;
  next: string;
  timestamp: number;
}
