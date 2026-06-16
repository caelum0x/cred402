import type {
  ChainAdapter,
  ChainCapabilities,
  ChainEvent,
  ChainEventFilter,
  CreditDrawRequest,
  CreditRepaymentRequest,
  TransactionResult,
} from "../../core/ChainAdapter.js";
import type { AddressBindingEnvelope } from "../../../../../crosschain/standards/bindings.js";
import { verifyAddressBinding } from "../../../../../crosschain/standards/bindings.js";
import type { UniversalReceiptEnvelope } from "../../../../../crosschain/standards/receipts.js";
import { makeReceiptId } from "../../../../../crosschain/standards/receipts.js";
import type { EvidenceAttestationEnvelope } from "../../../../../crosschain/standards/evidence.js";
import type { CreditAuthorizationNote } from "../../../../../crosschain/standards/credit_notes.js";
import { SolanaSatelliteVault, solanaSignature } from "./SolanaSatelliteVault.js";

/**
 * SolanaAdapter — a Solana satellite (Anchor program + SPL settlement). It settles
 * x402 payments locally in SPL stablecoins, mirrors Casper-rooted address bindings,
 * and executes credit through a {@link SolanaSatelliteVault} gated by Casper-issued
 * Credit Authorization Notes. Casper remains the identity/reputation/policy root;
 * Solana provides high-throughput execution and liquidity.
 */
export class SolanaAdapter implements ChainAdapter {
  private readonly events: ChainEvent[] = [];

  constructor(
    private readonly chainIdStr: string,
    readonly vault: SolanaSatelliteVault,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  chainId(): string {
    return this.chainIdStr;
  }
  family(): "solana" {
    return "solana";
  }
  async getCapabilities(): Promise<ChainCapabilities> {
    // Anchor programs + SPL settlement; sub-second slots, ~13s economic finality.
    return { smartContracts: true, x402Settlement: true, creditExecution: true, finalitySeconds: 13 };
  }

  async bindAgentAddress(input: AddressBindingEnvelope): Promise<TransactionResult> {
    const check = verifyAddressBinding(input, this.clock());
    if (!check.ok) return { ok: false, tx_hash: "", detail: check.reason };
    const tx_hash = solanaSignature(`bind:${input.external_address}:${input.agent_id}`);
    this.emit("AddressBindingMirrored", { agent_id: input.agent_id, address: input.external_address });
    return { ok: true, tx_hash };
  }

  /** Local x402 settlement → a Universal Receipt the relayer anchors to Casper. */
  async submitReceipt(input: UniversalReceiptEnvelope): Promise<TransactionResult> {
    const tx_hash = makeReceiptId(input);
    this.emit("ReceiptCreated", {
      receipt_id: tx_hash,
      seller: input.seller_agent_id,
      amount: input.amount,
      envelope: input,
    });
    return { ok: true, tx_hash };
  }

  async submitEvidence(input: EvidenceAttestationEnvelope): Promise<TransactionResult> {
    const tx_hash = solanaSignature(`evidence:${input.evidence_hash}:${input.agent_id}`);
    this.emit("EvidenceMirrored", { uaid: input.uaid, agent_id: input.agent_id });
    return { ok: true, tx_hash };
  }

  async verifyCreditAuthorization(note: CreditAuthorizationNote): Promise<boolean> {
    return this.vault.verifyNote(note, this.clock()).ok;
  }

  async drawCredit(input: CreditDrawRequest): Promise<TransactionResult> {
    try {
      const draw = this.vault.draw(input.note, BigInt(input.amount), this.clock());
      this.emit("CreditDrawn", { agent_id: draw.agent_id, amount: draw.amount.toString(), note_id: draw.note_id });
      return { ok: true, tx_hash: draw.tx_hash };
    } catch (err) {
      return { ok: false, tx_hash: "", detail: (err as Error).message };
    }
  }

  async repayCredit(input: CreditRepaymentRequest): Promise<TransactionResult> {
    const { tx_hash, remaining } = this.vault.repay(input.agent_id, BigInt(input.amount), this.clock());
    this.emit("CreditRepaid", { agent_id: input.agent_id, amount: input.amount, remaining: remaining.toString() });
    return { ok: true, tx_hash };
  }

  async *watchEvents(filter: ChainEventFilter): AsyncIterable<ChainEvent> {
    for (const e of this.events) if (!filter.type || e.type === filter.type) yield e;
  }

  recentEvents(): ChainEvent[] {
    return [...this.events];
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.events.push({ chain: this.chainIdStr, type, data });
  }
}
