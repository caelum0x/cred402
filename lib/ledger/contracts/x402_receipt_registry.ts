import type { Receipt, ReceiptStatus, ServiceType } from "../../core/types.js";
import { deployHash, shortId } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "X402ReceiptRegistry";

/**
 * X402ReceiptRegistry — stores payment-receipt commitments for every x402
 * machine-to-machine payment. These signed receipts are the verifiable cash-flow
 * proofs the credit policy underwrites against. Mirrors
 * `contracts/x402_receipt_registry`.
 */
export class X402ReceiptRegistry {
  private readonly receipts = new Map<string, Receipt>();
  // Replay protection (p2 §6.3 invariants, §14 threat 2):
  private readonly usedNonces = new Set<string>(); // `${payer}:${nonce}`
  private readonly usedProofs = new Set<string>(); // payment_proof_hash

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  record_receipt(args: {
    payer_agent: string;
    seller_agent: string;
    service_type: ServiceType;
    amount: bigint;
    rwa_reference_hash: string;
    result_hash: string;
    payment_proof_hash: string;
    request_hash?: string;
    nonce: string;
    expires_at?: number;
    dispute_window?: number;
  }): Receipt {
    const now = this.clock.now();
    // Invariant: an expired payment proof cannot be recorded.
    if (args.expires_at !== undefined && now > args.expires_at) {
      throw new Error(`x402 payment proof expired (now ${now} > expires_at ${args.expires_at})`);
    }
    // Invariant: one nonce can only be used once per payer domain.
    const nonceKey = `${args.payer_agent}:${args.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      throw new Error(`x402 nonce replay detected for ${args.payer_agent}: ${args.nonce}`);
    }
    // Invariant: a payment proof cannot be replayed.
    if (this.usedProofs.has(args.payment_proof_hash)) {
      throw new Error(`x402 payment proof replay detected`);
    }
    this.usedNonces.add(nonceKey);
    this.usedProofs.add(args.payment_proof_hash);

    const receipt: Receipt = {
      receipt_id: shortId("rcpt"),
      payer_agent: args.payer_agent,
      seller_agent: args.seller_agent,
      service_type: args.service_type,
      amount: args.amount,
      timestamp: now,
      rwa_reference_hash: args.rwa_reference_hash,
      result_hash: args.result_hash,
      payment_proof_hash: args.payment_proof_hash,
      request_hash: args.request_hash ?? "",
      nonce: args.nonce,
      expires_at: args.expires_at ?? now + (args.dispute_window ?? 86_400),
      dispute_window: args.dispute_window ?? 86_400,
      status: "pending",
    };
    this.receipts.set(receipt.receipt_id, receipt);
    this.bus.emit("ReceiptRecorded", CONTRACT, deployHash(), {
      receipt_id: receipt.receipt_id,
      payer_agent: receipt.payer_agent,
      seller_agent: receipt.seller_agent,
      amount: receipt.amount.toString(),
      service_type: receipt.service_type,
      result_hash: receipt.result_hash,
    });
    return { ...receipt };
  }

  /** Mark a receipt settled once the buyer confirms delivery of the report. */
  settle_receipt(receipt_id: string): void {
    const r = this.must(receipt_id);
    if (r.status === "pending") r.status = "settled";
  }

  finalize_receipt(receipt_id: string): Receipt {
    const r = this.must(receipt_id);
    if (r.status === "disputed") throw new Error(`cannot finalize disputed receipt ${receipt_id}`);
    r.status = "finalized";
    this.bus.emit("ReceiptFinalized", CONTRACT, deployHash(), { receipt_id });
    return { ...r };
  }

  dispute_receipt(receipt_id: string, dispute_hash: string): Receipt {
    const r = this.must(receipt_id);
    r.status = "disputed";
    this.bus.emit("ReceiptDisputed", CONTRACT, deployHash(), { receipt_id, dispute_hash });
    return { ...r };
  }

  get(receipt_id: string): Receipt | undefined {
    const r = this.receipts.get(receipt_id);
    return r ? { ...r } : undefined;
  }

  list(): Receipt[] {
    return [...this.receipts.values()].map((r) => ({ ...r }));
  }

  forSeller(seller_agent: string): Receipt[] {
    return this.list().filter((r) => r.seller_agent === seller_agent);
  }

  private must(receipt_id: string): Receipt {
    const r = this.receipts.get(receipt_id);
    if (!r) throw new Error(`unknown receipt: ${receipt_id}`);
    return r;
  }
}
