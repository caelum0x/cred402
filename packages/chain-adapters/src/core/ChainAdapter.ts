import type { AddressBindingEnvelope } from "../../../../crosschain/standards/bindings.js";
import type { UniversalReceiptEnvelope } from "../../../../crosschain/standards/receipts.js";
import type { EvidenceAttestationEnvelope } from "../../../../crosschain/standards/evidence.js";
import type { CreditAuthorizationNote } from "../../../../crosschain/standards/credit_notes.js";

export type ChainFamily = "casper" | "evm" | "solana" | "cosmos" | "move" | "bitcoin";

export interface ChainCapabilities {
  smartContracts: boolean;
  x402Settlement: boolean;
  creditExecution: boolean;
  finalitySeconds: number;
}

export interface TransactionResult {
  ok: boolean;
  tx_hash: string;
  detail?: string;
}

export interface CreditDrawRequest {
  note: CreditAuthorizationNote;
  agent_id: string;
  amount: string; // asset smallest units
}

export interface CreditRepaymentRequest {
  agent_id: string;
  amount: string;
}

export interface ChainEvent {
  chain: string;
  type: string;
  data: Record<string, unknown>;
}

export interface ChainEventFilter {
  type?: string;
}

/**
 * ChainAdapter (p3) — the single interface that makes Cred402 "all chains" without
 * rewriting the product per chain. Casper is the root adapter; EVM/Solana/Cosmos/
 * Move/Bitcoin are satellites. Identity, reputation and credit policy root on
 * Casper; execution and liquidity happen on the satellite.
 */
export interface ChainAdapter {
  chainId(): string;
  family(): ChainFamily;
  getCapabilities(): Promise<ChainCapabilities>;

  bindAgentAddress(input: AddressBindingEnvelope): Promise<TransactionResult>;
  submitReceipt(input: UniversalReceiptEnvelope): Promise<TransactionResult>;
  submitEvidence(input: EvidenceAttestationEnvelope): Promise<TransactionResult>;

  verifyCreditAuthorization(note: CreditAuthorizationNote): Promise<boolean>;
  drawCredit(input: CreditDrawRequest): Promise<TransactionResult>;
  repayCredit(input: CreditRepaymentRequest): Promise<TransactionResult>;

  watchEvents(filter: ChainEventFilter): AsyncIterable<ChainEvent>;
}
