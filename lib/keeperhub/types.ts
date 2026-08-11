/**
 * KeeperHub — the execution & reliability layer for on-chain AI agents. Cred402's
 * agents *decide* (who is creditworthy, how much to draw, when to repay); KeeperHub
 * *executes* the resulting transaction on-chain with guarantees: preflight
 * simulation, smart gas estimation with exponential backoff, MEV-protected private
 * routing, an audit trail, and pay-per-execution over x402 / MPP.
 *
 * KeeperHub is a Streamable-HTTP MCP server (https://app.keeperhub.com/mcp,
 * `Authorization: Bearer kh_<key>`). Its direct-execution tools —
 * `execute_contract_call`, `execute_transfer`, `get_direct_execution_status` — take
 * a `simulate: true` preflight flag and return an execution id you poll to a tx
 * hash. This module models that surface faithfully with a deterministic sim path so
 * the whole loop runs with no key and no network.
 *
 * Docs: https://docs.keeperhub.com/ai-tools/mcp-server
 */

/** What an agent wants executed on-chain. Chain ids are KeeperHub's string form. */
export interface ExecutionIntent {
  kind: "credit_draw" | "credit_repay" | "contract_call" | "transfer";
  /** KeeperHub numeric chain id as a string, e.g. "114" (Coston2), "8453" (Base). */
  chain_id: string;
  /** Target contract (write) or recipient (transfer). */
  to: string;
  /** Solidity function signature for a contract call, e.g. "executeDraw(bytes32,uint256)". */
  function?: string;
  /** ABI-typed args for the call. */
  args?: unknown[];
  /** Native value (wei, decimal string) for transfers. */
  value?: string;
  /** The agent this execution acts for — carried into the audit trail. */
  agent_id?: string;
  /** Human label for the audit trail + KeeperHub dashboard. */
  label: string;
  /** Extra context recorded on the audit trail (trigger, decision inputs, …). */
  metadata?: Record<string, unknown>;
}

/** Result of KeeperHub's preflight simulation (no broadcast). */
export interface SimulationResult {
  ok: boolean;
  gas_estimate?: number;
  revert_reason?: string;
  source: "keeperhub" | "sim";
}

/** Smart gas pricing (EIP-1559) with the backoff attempt that produced it. */
export interface GasEstimate {
  max_fee_per_gas: string; // wei
  max_priority_fee_per_gas: string; // wei
  gas_limit: number;
  attempts: number; // how many congestion-backoff bumps were applied
  strategy: "eip1559-exponential-backoff";
}

/** Which pay-per-execution rail settled (or would settle) this execution. */
export type PaymentProtocol = "x402" | "mpp" | "sponsored" | "none";

export interface PaymentReceipt {
  protocol: PaymentProtocol;
  /** USDC (Base) / USDC.e (Tempo) smallest-unit price paid for the execution. */
  amount: string;
  asset: string; // "USDC" | "USDC.e"
  network: string; // "base" | "tempo" | ...
  /** x402: EIP-3009 TransferWithAuthorization proof / MPP: facilitator proof id. */
  payment_proof?: string;
  detail?: string;
}

/** One immutable audit-trail entry: trigger → simulation → submit → outcome. */
export interface AuditRecord {
  audit_id: string;
  execution_id: string;
  agent_id?: string;
  chain_id: string;
  intent_kind: ExecutionIntent["kind"];
  label: string;
  trigger: Record<string, unknown>;
  simulation: SimulationResult;
  gas: GasEstimate;
  payment: PaymentReceipt;
  private_routed: boolean;
  sponsored: boolean;
  tx_hash: string;
  gas_used?: number;
  status: "simulated" | "submitted" | "confirmed" | "failed";
  detail?: string;
  submitted_at: number;
  confirmed_at?: number;
}

/** What the executor returns to the adapter after a real (or simulated) execution. */
export interface ExecutionResult {
  ok: boolean;
  execution_id: string;
  tx_hash: string;
  audit_id: string;
  simulation: SimulationResult;
  gas: GasEstimate;
  payment: PaymentReceipt;
  private_routed: boolean;
  sponsored: boolean;
  gas_used?: number;
  source: "keeperhub" | "sim";
  detail?: string;
}

/**
 * The seam a satellite adapter uses to push its decided transaction through
 * KeeperHub. Any executor (real KeeperHub or the deterministic sim) satisfies it.
 */
export interface OnchainExecutor {
  execute(intent: ExecutionIntent): Promise<ExecutionResult>;
  auditTrail(): AuditRecord[];
  isLive(): boolean;
}
