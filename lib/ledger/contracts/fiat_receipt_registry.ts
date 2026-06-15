import { deployHash } from "../../core/hash.js";
import {
  verifyFiatReceipt,
  type FiatReceiptEnvelope,
  type FiatSettlementStatus,
} from "../../realfi/envelopes.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "FiatReceiptRegistry";

export type FiatReceiptStatus = FiatSettlementStatus | "finalized";

export interface FiatReceipt {
  receipt_id: string;
  provider: string;
  seller_agent: string;
  operator_id: string;
  amount: string;
  currency: string;
  service_type: string;
  provider_receipt_hash: string;
  result_hash: string;
  status: FiatReceiptStatus;
  recorded_at: number;
  envelope: FiatReceiptEnvelope;
}

/**
 * FiatReceiptRegistry (p6) — the Stripe-equivalent of {@link X402ReceiptRegistry}.
 * Records privacy-preserving Fiat Receipt Envelope commitments so fiat revenue
 * counts toward an agent's credit profile WITHOUT putting PII on-chain. Stripe
 * webhook payloads never reach here — only the hashed, public-safe envelope.
 */
export class FiatReceiptRegistry {
  private readonly receipts = new Map<string, FiatReceipt>();
  private readonly usedProviderEvents = new Set<string>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  record_fiat_receipt(fre: FiatReceiptEnvelope, receipt_id: string): FiatReceipt {
    const check = verifyFiatReceipt(fre, receipt_id);
    if (!check.ok) throw new Error(`fiat receipt rejected: ${check.reason}`);
    if (this.receipts.has(receipt_id)) throw new Error("fiat receipt already recorded");
    // Idempotency: a provider event maps to exactly one on-chain receipt.
    const eventKey = `${fre.provider}:${fre.provider_event_id_hash}`;
    if (this.usedProviderEvents.has(eventKey)) throw new Error("provider event already recorded");
    this.usedProviderEvents.add(eventKey);

    const rec: FiatReceipt = {
      receipt_id,
      provider: fre.provider,
      seller_agent: fre.seller_agent,
      operator_id: fre.operator_id,
      amount: fre.amount,
      currency: fre.currency,
      service_type: fre.service_type,
      provider_receipt_hash: fre.provider_receipt_hash,
      result_hash: fre.result_hash,
      status: fre.settlement_status,
      recorded_at: this.clock.now(),
      envelope: fre,
    };
    this.receipts.set(receipt_id, rec);
    this.bus.emit("FiatReceiptRecorded", CONTRACT, deployHash(), {
      receipt_id,
      provider: fre.provider,
      seller_agent: fre.seller_agent,
      currency: fre.currency,
      service_type: fre.service_type,
    });
    return clone(rec);
  }

  finalize_fiat_receipt(receipt_id: string): void {
    const r = this.must(receipt_id);
    if (r.status === "disputed") throw new Error("cannot finalize a disputed fiat receipt");
    r.status = "finalized";
    this.bus.emit("FiatReceiptFinalized", CONTRACT, deployHash(), { receipt_id });
  }

  dispute_fiat_receipt(receipt_id: string, reason_hash: string): void {
    const r = this.must(receipt_id);
    r.status = "disputed";
    this.bus.emit("FiatReceiptDisputed", CONTRACT, deployHash(), { receipt_id, reason_hash });
  }

  get_fiat_receipt(receipt_id: string): FiatReceipt | undefined {
    const r = this.receipts.get(receipt_id);
    return r ? clone(r) : undefined;
  }

  forSeller(seller_agent: string): FiatReceipt[] {
    return this.list().filter((r) => r.seller_agent === seller_agent);
  }

  list(): FiatReceipt[] {
    return [...this.receipts.values()].map(clone);
  }

  private must(receipt_id: string): FiatReceipt {
    const r = this.receipts.get(receipt_id);
    if (!r) throw new Error(`unknown fiat receipt: ${receipt_id}`);
    return r;
  }
}

function clone(r: FiatReceipt): FiatReceipt {
  return { ...r, envelope: { ...r.envelope } };
}
