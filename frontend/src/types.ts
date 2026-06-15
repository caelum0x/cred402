// Server-serialized shapes: all bigint motes arrive as decimal strings.

export interface Agent {
  agent_id: string;
  service_type: string;
  stake: string;
  total_jobs_completed: number;
  accuracy_score: number;
  dispute_rate: number;
  reputation_score: number;
  credit_score: number;
  active: boolean;
  agent_public_key: string;
}

export interface Receipt {
  receipt_id: string;
  payer_agent: string;
  seller_agent: string;
  service_type: string;
  amount: string;
  timestamp: number;
  result_hash: string;
  payment_proof_hash: string;
  status: "pending" | "settled" | "disputed" | "finalized";
}

export interface Evidence {
  evidence_id: string;
  rwa_id: string;
  agent_id: string;
  evidence_type: string;
  evidence_hash: string;
  confidence: number;
  verified: boolean;
  linked_receipt_id: string;
}

export interface RiskResult {
  recommended_max_ltv: number;
  approved: boolean;
  approved_amount: string;
  rationale: string[];
}

export interface RwaJob {
  rwa_id: string;
  name: string;
  location: string;
  requested_loan: string;
  needed_evidence: string[];
  status: string;
  risk_result?: RiskResult;
}

export interface CreditLine {
  agent_id: string;
  max_credit: string;
  drawn: string;
  interest_rate_bps: number;
  origination_fee_bps: number;
  health_factor_bps: number;
  due_timestamp: number;
  status: "active" | "frozen" | "defaulted";
}

export interface AgentPassport {
  agent_id: string;
  service_type: string;
  operator: string;
  reputation_score: number;
  credit_score: number;
  capabilities: string[];
  spending_limit: string;
  risk_flags: string[];
}

export interface DisputeEvidence {
  submitter: string;
  evidence_hash: string;
  note: string;
  timestamp: number;
}

export interface Dispute {
  dispute_id: string;
  dispute_type: string;
  complainant: string;
  respondent_agent: string;
  receipt_id?: string;
  status: string;
  evidence: DisputeEvidence[];
  verdict?: string;
  slash_amount: string;
  rationale: string[];
  opened_at: number;
}

export interface RwaAsset {
  rwa_id: string;
  asset_type: string;
  issuer: string;
  jurisdiction_code: string;
  status: string;
}

export interface GovernanceParams {
  protocol_fee_bps: number;
  origination_fee_bps: number;
  min_reputation_to_draw: number;
  max_agent_exposure: string;
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

export interface SlashRecord {
  slash_id: string;
  agent_id: string;
  amount: string;
  reason: string;
  timestamp: number;
}

export interface PoolState {
  total_liquidity: string;
  outstanding_credit: string;
  interest_accrued: string;
  defaults: number;
}

export interface ChainEvent {
  seq: number;
  name: string;
  contract: string;
  deploy_hash: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface AddressBinding {
  agent_id: string;
  external_chain: string;
  external_address: string;
  bound_at: number;
  revoked_at?: number;
}

export interface ExternalReceipt {
  receipt_id: string;
  origin_chain: string;
  settlement_network: string;
  seller_agent_id: string;
  asset: string;
  amount: string;
  service_type: string;
  status: string;
}

export interface GlobalExposure {
  agent_id: string;
  outstanding: string;
  reserved: string;
  max_allowed: string;
  frozen: boolean;
}

export interface StoredCan {
  status: string;
  note: {
    note_id: string;
    agent_id: string;
    target_chain: string;
    max_draw: string;
    asset: string;
    credit_score: number;
    expires_at: number;
  };
}

export interface ContractVersion {
  name: string;
  version: number;
  package_hash: string;
}

export interface FiatReceipt {
  receipt_id: string;
  provider: string;
  seller_agent: string;
  operator_id: string;
  amount: string;
  currency: string;
  service_type: string;
  status: string;
  recorded_at: number;
}

export interface OperatorVerification {
  operator_id: string;
  provider: string;
  verification_level: string;
  jurisdiction: string;
  status: string;
  verified_at: number;
  expires_at: number;
}

export interface RealFiAttestation {
  attestation_id: string;
  attestation_type: string;
  subject_id: string;
  provider: string;
  status: string;
}

export interface Snapshot {
  contractHashes: Record<string, string>;
  policyVersion: string;
  policyPublicKey: string;
  fiatReceipts?: FiatReceipt[];
  operatorVerifications?: OperatorVerification[];
  realfiAttestations?: RealFiAttestation[];
  addressBindings: AddressBinding[];
  externalReceipts: ExternalReceipt[];
  globalExposure: GlobalExposure[];
  creditNotes: StoredCan[];
  contractVersions: ContractVersion[];
  agents: Agent[];
  receipts: Receipt[];
  evidence: Evidence[];
  jobs: RwaJob[];
  creditLines: CreditLine[];
  pool: PoolState;
  estimatedApy: number;
  assets: RwaAsset[];
  disputes: Dispute[];
  slashes: SlashRecord[];
  slashReserves: Record<string, string>;
  governance: GovernanceParams;
  governanceHistory: ParameterChange[];
  passports: AgentPassport[];
  events: ChainEvent[];
}
