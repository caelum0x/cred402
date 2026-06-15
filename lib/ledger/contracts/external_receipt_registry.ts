import { deployHash } from "../../core/hash.js";
import { verifyUniversalReceipt, type UniversalReceiptEnvelope } from "../../../crosschain/standards/receipts.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "ExternalReceiptRegistry";

export type ExternalReceiptStatus = "anchored" | "finalized" | "challenged";

export interface ExternalReceipt {
  receipt_id: string;
  origin_chain: string;
  settlement_network: string;
  payer_agent_id: string;
  seller_agent_id: string;
  asset: string;
  amount: string;
  service_type: string;
  payment_proof_hash: string;
  settlement_tx_hash: string;
  anchored_at: number;
  status: ExternalReceiptStatus;
  envelope: UniversalReceiptEnvelope;
}

/**
 * ExternalReceiptRegistry (p3) — anchors non-Casper x402 receipts. An agent earns
 * on Base/Solana/Cosmos; the Universal Receipt Envelope is verified and its
 * canonical commitment is recorded here, so reputation and credit settle on
 * Casper even though the work happened elsewhere. Nonce uniqueness per payer
 * prevents cross-chain receipt replay.
 */
export class ExternalReceiptRegistry {
  private readonly receipts = new Map<string, ExternalReceipt>();
  private readonly usedNonces = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  record_external_receipt(ure: UniversalReceiptEnvelope, receipt_id: string): ExternalReceipt {
    const check = verifyUniversalReceipt(ure, receipt_id);
    if (!check.ok) throw new Error(`external receipt rejected: ${check.reason}`);
    if (this.receipts.has(receipt_id)) throw new Error("external receipt already anchored");
    const nonceKey = `${ure.origin_chain}:${ure.payer_agent_id}:${ure.nonce}`;
    if (this.usedNonces.has(nonceKey)) throw new Error("external receipt nonce replay");
    this.usedNonces.add(nonceKey);

    const rec: ExternalReceipt = {
      receipt_id,
      origin_chain: ure.origin_chain,
      settlement_network: ure.settlement_network,
      payer_agent_id: ure.payer_agent_id,
      seller_agent_id: ure.seller_agent_id,
      asset: ure.asset,
      amount: ure.amount,
      service_type: ure.service_type,
      payment_proof_hash: ure.payment_proof_hash,
      settlement_tx_hash: ure.settlement_tx_hash,
      anchored_at: this.clock.now(),
      status: "anchored",
      envelope: ure,
    };
    this.receipts.set(receipt_id, rec);
    this.bus.emit("ExternalReceiptAnchored", CONTRACT, deployHash(), {
      receipt_id,
      origin_chain: ure.origin_chain,
      seller_agent_id: ure.seller_agent_id,
      asset: ure.asset,
      amount: ure.amount,
    });
    return clone(rec);
  }

  finalize_external_receipt(receipt_id: string): void {
    const r = this.must(receipt_id);
    if (r.status === "anchored") r.status = "finalized";
  }

  challenge_external_receipt(receipt_id: string): void {
    const r = this.must(receipt_id);
    r.status = "challenged";
  }

  forSeller(seller_agent_id: string): ExternalReceipt[] {
    return this.list().filter((r) => r.seller_agent_id === seller_agent_id);
  }

  get(receipt_id: string): ExternalReceipt | undefined {
    const r = this.receipts.get(receipt_id);
    return r ? clone(r) : undefined;
  }

  list(): ExternalReceipt[] {
    return [...this.receipts.values()].map(clone);
  }

  private must(receipt_id: string): ExternalReceipt {
    const r = this.receipts.get(receipt_id);
    if (!r) throw new Error(`unknown external receipt ${receipt_id}`);
    return r;
  }
}

function clone(r: ExternalReceipt): ExternalReceipt {
  return { ...r, envelope: { ...r.envelope } };
}
