import { buildUniversalReceipt } from "../crosschain/standards/index.js";
import { hashObject } from "../lib/core/hash.js";
import type { Ledger } from "../lib/ledger/index.js";
import type { ExternalReceiptProofStore } from "../lib/x402/external_receipt_proof_store.js";

/**
 * Algorand x402 receipt anchoring — the sub-domain that turns a settled Algorand
 * USDC credit-report payment into the same Casper-rooted Universal Receipt used by
 * the other satellite chains, plus the durable proof persistence and public usage
 * aggregation that back the paid endpoint.
 *
 * Extracted verbatim from ServerState (no behavior change): the functions operate
 * on an explicit context instead of `this`, so the persistent proof store and the
 * (reset-swappable) ledger are passed in fresh on every call.
 */
export interface AlgorandAnchorContext {
  /** The current live ledger (rebuilt on reset — always pass the fresh one). */
  readonly ledger: Ledger;
  /** Durable public receipt proofs (enabled with the production data dir). */
  readonly externalReceiptProofs?: ExternalReceiptProofStore;
  /** The Cred402 seller agent id that receives the anchored credit-score revenue. */
  readonly sellerAgentId: string;
}

/** A settled Algorand credit-report payment awaiting a Casper-rooted anchor. */
export interface AlgorandCreditScoreSettlement {
  agentId: string;
  network: string;
  networkName: string;
  usdcAsset: number;
  amountMicroUsdc: string;
  payer?: string;
  receiver: string;
  transaction?: string;
  report: unknown;
}

/**
 * Convert a successful Algorand x402 credit-report payment into the same
 * Casper-rooted Universal Receipt used by the other satellite chains.
 *
 * The facilitator authenticates the payer address and transaction, but it
 * does not assert a Cred402 agent id. Preserve that boundary by using an
 * address-derived external identity. Repeated delivery of the same settled
 * transaction returns the existing receipt without crediting revenue twice.
 */
export function anchorAlgorandCreditScoreSettlement(
  ctx: AlgorandAnchorContext,
  input: AlgorandCreditScoreSettlement,
): { receipt_id: string } | null {
  const payer = input.payer?.trim();
  const transaction = input.transaction?.trim();
  if (!payer || !transaction || !/^\d+$/.test(input.amountMicroUsdc)) {
    return null;
  }

  const existing = ctx.ledger.externalReceipts.list().find(
    (receipt) =>
      receipt.origin_chain === input.network &&
      receipt.settlement_tx_hash === transaction,
  );
  if (existing) {
    const sameSettlement =
      existing.payer_agent_id === `algorand:${payer}` &&
      existing.seller_agent_id === ctx.sellerAgentId &&
      existing.envelope.seller_address === input.receiver &&
      existing.asset === `algorand-asa:${input.usdcAsset}` &&
      existing.amount === input.amountMicroUsdc;
    if (sameSettlement) {
      persistExternalReceiptProof(ctx, existing.receipt_id);
      return { receipt_id: existing.receipt_id };
    }
    return null;
  }

  const { envelope, receipt_id } = buildUniversalReceipt({
    origin_chain: input.network,
    settlement_network: input.networkName,
    payer_agent_id: `algorand:${payer}`,
    seller_agent_id: ctx.sellerAgentId,
    payer_address: payer,
    seller_address: input.receiver,
    asset: `algorand-asa:${input.usdcAsset}`,
    amount: input.amountMicroUsdc,
    service_type: "credit-score",
    request_hash: hashObject({
      method: "GET",
      route: "/v1/x402/credit-score/:agentId",
      agent_id: input.agentId,
    }),
    result_hash: hashObject(input.report),
    payment_proof_hash: hashObject({
      network: input.network,
      transaction,
      payer,
      receiver: input.receiver,
      amount_micro_usdc: input.amountMicroUsdc,
    }),
    settlement_tx_hash: transaction,
    nonce: transaction,
    created_at: ctx.ledger.clock.now(),
  });

  if (ctx.ledger.externalReceipts.get(receipt_id)) {
    persistExternalReceiptProof(ctx, receipt_id);
    return { receipt_id };
  }

  try {
    // Algorand settlement is provisional until independently confirmed by
    // the configured Indexer; only finalized receipts affect credit signals.
    const anchored = ctx.ledger.anchorExternalReceipt(envelope, { finalize: false });
    persistExternalReceiptProof(ctx, anchored.receipt_id);
    return anchored;
  } catch {
    // Payment delivery must not fail if the local/indexing layer is
    // temporarily unavailable. The on-chain transaction remains canonical.
    return null;
  }
}

/** Live registry first, then the durable content-addressed proof store. */
export function externalReceiptProof(ctx: AlgorandAnchorContext, receiptId: string) {
  return (
    ctx.ledger.externalReceipts.get(receiptId) ??
    ctx.externalReceiptProofs?.get(receiptId)
  );
}

export function finalizeAlgorandExternalReceipt(ctx: AlgorandAnchorContext, receiptId: string): void {
  ctx.ledger.finalizeExternalReceipt(receiptId);
  persistExternalReceiptProof(ctx, receiptId);
}

export function challengeAlgorandExternalReceipt(ctx: AlgorandAnchorContext, receiptId: string): void {
  ctx.ledger.challengeExternalReceipt(receiptId);
  persistExternalReceiptProof(ctx, receiptId);
}

/** Public, aggregate-only usage proof for the Algorand challenge endpoint. */
export function algorandX402Usage(ctx: AlgorandAnchorContext, network: string, usdcAsset: number) {
  const asset = `algorand-asa:${usdcAsset}`;
  const byId = new Map(
    (ctx.externalReceiptProofs?.list() ?? []).map((receipt) => [receipt.receipt_id, receipt]),
  );
  for (const receipt of ctx.ledger.externalReceipts.list()) byId.set(receipt.receipt_id, receipt);
  const receipts = [...byId.values()]
    .filter((receipt) =>
      receipt.origin_chain === network &&
      receipt.asset === asset &&
      receipt.service_type === "credit-score" &&
      receipt.status === "finalized",
    )
    .sort((a, b) => b.anchored_at - a.anchored_at);
  const totalMicroUsdc = receipts.reduce(
    (total, receipt) => total + BigInt(receipt.amount),
    0n,
  );

  return {
    schema_version: "cred402.algorand-x402-usage.v1",
    network,
    usdc_asset: usdcAsset,
    paid_requests: receipts.length,
    unique_payers: new Set(receipts.map((receipt) => receipt.payer_agent_id)).size,
    total_micro_usdc: totalMicroUsdc.toString(),
    latest_payment_at: receipts[0]
      ? new Date(receipts[0].anchored_at * 1000).toISOString()
      : null,
    latest_receipts: receipts.slice(0, 10).map((receipt) => ({
      receipt_id: receipt.receipt_id,
      transaction: receipt.settlement_tx_hash,
      amount_micro_usdc: receipt.amount,
      anchored_at: new Date(receipt.anchored_at * 1000).toISOString(),
    })),
  };
}

export function persistExternalReceiptProof(ctx: AlgorandAnchorContext, receiptId: string): void {
  if (!ctx.externalReceiptProofs) return;
  const receipt = ctx.ledger.externalReceipts.get(receiptId);
  if (!receipt) return;
  try {
    ctx.externalReceiptProofs.put(receipt);
  } catch {
    // The paid response and live ledger anchor remain valid even if the
    // durability volume is temporarily unavailable. The proof endpoint can
    // still serve the live registry until storage recovers.
  }
}
