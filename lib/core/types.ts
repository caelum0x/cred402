/**
 * Shared domain types for Cred402.
 *
 * These mirror the on-chain state defined by the Odra contracts under
 * `contracts/`. The TypeScript ledger in `lib/ledger` is a faithful simulation
 * of those contracts so the full agent loop runs end-to-end without a live
 * Testnet, while the architecture stays identical.
 */

export type ServiceType =
  | "solar_output_verification"
  | "weather_risk"
  | "receivable_quality"
  | "risk_scoring"
  | "treasury_routing"
  | "monitoring";

// ---------------------------------------------------------------------------
// AgentRegistry
// ---------------------------------------------------------------------------

export interface Agent {
  agent_id: string;
  owner_public_key: string;
  agent_public_key: string;
  service_type: ServiceType;
  stake: bigint; // motes
  total_jobs_completed: number;
  /** Per-receipt revenue events used by the credit policy. */
  x402_revenue_history: RevenueEvent[];
  /** 0..100 — quality of evidence as later verified. */
  accuracy_score: number;
  /** 0..1 fraction of receipts disputed against the agent. */
  dispute_rate: number;
  /** 0..100 reputation, distinct from accuracy. */
  reputation_score: number;
  /** 0..100 underwriting score set by the CreditAgent. */
  credit_score: number;
  active: boolean;
  registered_at: number;
}

export interface RevenueEvent {
  receipt_id: string;
  amount: bigint; // motes
  timestamp: number;
  service_type: ServiceType;
}

// ---------------------------------------------------------------------------
// X402ReceiptRegistry
// ---------------------------------------------------------------------------

export type ReceiptStatus = "pending" | "settled" | "disputed" | "finalized";

export interface Receipt {
  receipt_id: string;
  payer_agent: string;
  seller_agent: string;
  service_type: ServiceType;
  amount: bigint; // motes
  timestamp: number;
  rwa_reference_hash: string;
  result_hash: string;
  payment_proof_hash: string;
  request_hash: string;
  nonce: string;
  expires_at: number;
  dispute_window: number; // seconds
  status: ReceiptStatus;
}

// ---------------------------------------------------------------------------
// RWAEvidenceRegistry
// ---------------------------------------------------------------------------

export interface Evidence {
  evidence_id: string;
  rwa_id: string;
  agent_id: string;
  evidence_type: string;
  evidence_hash: string;
  confidence: number; // 0..100
  timestamp: number;
  linked_receipt_id: string;
  verified: boolean;
}

// ---------------------------------------------------------------------------
// RWA jobs (the demand side that hires agents)
// ---------------------------------------------------------------------------

export type RwaJobStatus = "open" | "evidence_complete" | "funded" | "rejected";

export interface RwaJob {
  rwa_id: string;
  name: string;
  location: string;
  monthly_output_kwh: number;
  expected_receivable_usd: number;
  requested_loan: bigint; // motes (test units)
  collateral_type: string;
  needed_evidence: string[];
  status: RwaJobStatus;
  bounty_per_evidence: bigint; // motes paid via x402 for each evidence
  risk_result?: RiskResult;
  created_at: number;
}

export interface RiskResult {
  recommended_max_ltv: number; // 0..1
  approved: boolean;
  approved_amount: bigint;
  rationale: string[];
}

// ---------------------------------------------------------------------------
// AgentCreditPool
// ---------------------------------------------------------------------------

export type CreditStatus = "active" | "frozen" | "defaulted";

export interface CreditLine {
  agent_id: string;
  max_credit: bigint; // motes
  drawn: bigint; // motes
  interest_rate_bps: number;
  origination_fee_bps: number;
  health_factor_bps: number; // 10000 = 1.0; higher is safer
  opened_at: number;
  due_timestamp: number;
  status: CreditStatus;
}

export interface PoolState {
  total_liquidity: bigint;
  outstanding_credit: bigint;
  interest_accrued: bigint;
  defaults: number;
}

// ---------------------------------------------------------------------------
// Events (Casper streaming-events analogue)
// ---------------------------------------------------------------------------

export type EventName =
  | "AgentRegistered"
  | "Staked"
  | "ReceiptRecorded"
  | "ReceiptFinalized"
  | "ReceiptDisputed"
  | "EvidenceSubmitted"
  | "EvidenceVerified"
  | "RwaJobCreated"
  | "RwaJobScored"
  | "RwaAssetRegistered"
  | "CreditScoreSet"
  | "CreditLineOpened"
  | "CreditDrawn"
  | "CreditRepaid"
  | "CreditFrozen"
  | "CreditDefaulted"
  | "ReputationUpdated"
  | "StakeSlashed"
  | "LiquidityDeposited"
  | "PolicyUpgraded"
  // p2 protocol layer
  | "DisputeOpened"
  | "DisputeEvidenceSubmitted"
  | "DisputeVerdictIssued"
  | "DisputeClosed"
  | "StakeSlashedToVault"
  | "SlashDistributed"
  | "GovernanceParameterUpdated"
  | "ProtocolPaused"
  | "ProtocolUnpaused"
  // p3 omnichain layer (Casper-rooted, chain-executed)
  | "AddressBound"
  | "AddressRevoked"
  | "ExternalReceiptAnchored"
  | "ExposureReserved"
  | "ExposureReleased"
  | "ExposureFrozen"
  | "CreditNoteIssued"
  | "CreditNoteConsumed"
  | "CreditNoteRevoked"
  | "ContractUpgraded"
  // p6 RealFi Bridge layer
  | "FiatReceiptRecorded"
  | "FiatReceiptFinalized"
  | "FiatReceiptDisputed"
  | "OperatorVerified"
  | "OperatorVerificationRevoked"
  | "RealFiAttestationRecorded"
  | "RealFiAttestationRevoked";

export interface ChainEvent {
  seq: number;
  name: EventName;
  contract: string;
  deploy_hash: string;
  timestamp: number;
  data: Record<string, unknown>;
}
