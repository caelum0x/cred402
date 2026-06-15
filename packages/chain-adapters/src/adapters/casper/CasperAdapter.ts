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
import type { UniversalReceiptEnvelope } from "../../../../../crosschain/standards/receipts.js";
import type { EvidenceAttestationEnvelope } from "../../../../../crosschain/standards/evidence.js";
import { verifyEvidenceAttestation } from "../../../../../crosschain/standards/evidence.js";
import {
  verifyCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../../../crosschain/standards/credit_notes.js";
import type { Ledger } from "../../../../../lib/ledger/ledger.js";

/**
 * CasperAdapter — the ROOT adapter. Identity, reputation, x402 receipt history,
 * RWA evidence, credit policy, disputes and global exposure all settle here. It
 * wraps the canonical Casper contract suite (the Ledger).
 */
export class CasperAdapter implements ChainAdapter {
  constructor(private readonly ledger: Ledger) {}

  chainId(): string {
    return "casper";
  }
  family(): "casper" {
    return "casper";
  }
  async getCapabilities(): Promise<ChainCapabilities> {
    return { smartContracts: true, x402Settlement: true, creditExecution: true, finalitySeconds: 16 };
  }

  async bindAgentAddress(input: AddressBindingEnvelope): Promise<TransactionResult> {
    try {
      const b = this.ledger.bindings.bind_external_address(input);
      return { ok: true, tx_hash: this.ledger.contractHashes.AddressBindingRegistry, detail: `${b.external_chain}:${b.external_address}` };
    } catch (err) {
      return { ok: false, tx_hash: "", detail: (err as Error).message };
    }
  }

  /** Anchor an external receipt to Casper (credits seller reputation + revenue). */
  async submitReceipt(input: UniversalReceiptEnvelope): Promise<TransactionResult> {
    try {
      const { receipt_id } = this.ledger.anchorExternalReceipt(input);
      return { ok: true, tx_hash: receipt_id };
    } catch (err) {
      return { ok: false, tx_hash: "", detail: (err as Error).message };
    }
  }

  async submitEvidence(input: EvidenceAttestationEnvelope): Promise<TransactionResult> {
    const agent = this.ledger.agents.get(input.agent_id);
    if (!agent) return { ok: false, tx_hash: "", detail: "unknown agent" };
    const check = verifyEvidenceAttestation(input, agent.agent_public_key);
    if (!check.ok) return { ok: false, tx_hash: "", detail: check.reason };
    const ev = this.ledger.evidence.submit_evidence({
      rwa_id: input.uaid,
      agent_id: input.agent_id,
      evidence_type: input.evidence_type,
      evidence_hash: input.evidence_hash,
      confidence: Math.round(input.confidence_bps / 100),
      linked_receipt_id: input.linked_receipt_id,
    });
    return { ok: true, tx_hash: ev.evidence_id };
  }

  async verifyCreditAuthorization(note: CreditAuthorizationNote): Promise<boolean> {
    return verifyCreditAuthorizationNote(note, this.ledger.policyPublicKeyHex, {
      now: this.ledger.clock.now(),
      target_chain: note.target_chain,
      target_pool: note.target_pool,
    }).ok;
  }

  /** Credit executes on satellites; on Casper a "draw" only confirms exposure. */
  async drawCredit(input: CreditDrawRequest): Promise<TransactionResult> {
    this.ledger.notes.consume_can(input.note.note_id, BigInt(input.amount));
    return { ok: true, tx_hash: this.ledger.contractHashes.CreditAuthorizationNotes };
  }

  async repayCredit(input: CreditRepaymentRequest): Promise<TransactionResult> {
    this.ledger.exposure.decrease_exposure(input.agent_id, BigInt(input.amount));
    return { ok: true, tx_hash: this.ledger.contractHashes.GlobalExposureManager };
  }

  async *watchEvents(filter: ChainEventFilter): AsyncIterable<ChainEvent> {
    for (const e of this.ledger.bus.all()) {
      if (!filter.type || e.name === filter.type) yield { chain: "casper", type: e.name, data: e.data };
    }
  }

  /**
   * Relayer reconciliation (p3): a satellite reported a credit draw. Casper
   * activates the reserved global exposure for that Credit Authorization Note,
   * moving it from `reserved` to `outstanding`. Keeps Casper the single source of
   * truth for cross-chain exposure even though the cash moved on the satellite.
   */
  confirmSatelliteDraw(noteId: string, amount: bigint): TransactionResult {
    try {
      this.ledger.notes.consume_can(noteId, amount);
      return { ok: true, tx_hash: this.ledger.contractHashes.CreditAuthorizationNotes };
    } catch (err) {
      return { ok: false, tx_hash: "", detail: (err as Error).message };
    }
  }
}
