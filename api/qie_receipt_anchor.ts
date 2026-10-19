import { buildUniversalReceipt } from "../crosschain/standards/index.js";
import { hashObject } from "../lib/core/hash.js";
import type { Ledger } from "../lib/ledger/index.js";
import type { ExternalReceiptProofStore } from "../lib/x402/external_receipt_proof_store.js";

/**
 * QIE x402 receipt anchoring — mirrors `algorand_receipt_anchor.ts` exactly,
 * EVM-shaped: turns a settled QIE credit-report payment into the same
 * Casper-rooted Universal Receipt used by the other satellite chains (Algorand,
 * and whatever Base/Solana/Cosmos routes exist), plus the durable proof
 * persistence and public usage aggregation that back the paid endpoint.
 */
export interface QieAnchorContext {
  /** The current live ledger (rebuilt on reset — always pass the fresh one). */
  readonly ledger: Ledger;
  /** Durable public receipt proofs (enabled with the production data dir). */
  readonly externalReceiptProofs?: ExternalReceiptProofStore;
  /** The Cred402 seller agent id that receives the anchored credit-score revenue. */
  readonly sellerAgentId: string;
}

/** A settled QIE credit-report payment awaiting a Casper-rooted anchor. */
export interface QieCreditScoreSettlement {
  agentId: string;
  network: string; // CAIP-2, e.g. "eip155:1983"
  networkName: string; // "testnet" | "mainnet"
  assetAddress: string; // the QUSDC/test ERC-20 contract address on QIE
  amountBaseUnits: string;
  payer?: string; // 0x address
  receiver: string; // 0x address
  transaction?: string; // 0x tx hash
  report: unknown;
}

/**
 * Convert a successful QIE x402 credit-report payment into the same
 * Casper-rooted Universal Receipt used by the other satellite chains.
 *
 * The facilitator authenticates the payer address and transaction, but it
 * does not assert a Cred402 agent id. Preserve that boundary by using an
 * address-derived external identity. Repeated delivery of the same settled
 * transaction returns the existing receipt without crediting revenue twice.
 */
export function anchorQieCreditScoreSettlement(
  ctx: QieAnchorContext,
  input: QieCreditScoreSettlement,
): { receipt_id: string } | null {
  const payer = input.payer?.trim();
  const transaction = input.transaction?.trim();
  if (!payer || !transaction || !/^\d+$/.test(input.amountBaseUnits)) {
    return null;
  }

  const existing = ctx.ledger.externalReceipts.list().find(
    (receipt) =>
      receipt.origin_chain === input.network &&
      receipt.settlement_tx_hash === transaction,
  );
  if (existing) {
    const sameSettlement =
      existing.payer_agent_id === `qie:${payer}` &&
      existing.seller_agent_id === ctx.sellerAgentId &&
      existing.envelope.seller_address === input.receiver &&
      existing.asset === `qie-erc20:${input.assetAddress}` &&
      existing.amount === input.amountBaseUnits;
    if (sameSettlement) {
      persistExternalReceiptProof(ctx, existing.receipt_id);
      return { receipt_id: existing.receipt_id };
    }
    return null;
  }

  const { envelope, receipt_id } = buildUniversalReceipt({
    origin_chain: input.network,
    settlement_network: input.networkName,
    payer_agent_id: `qie:${payer}`,
    seller_agent_id: ctx.sellerAgentId,
    payer_address: payer,
    seller_address: input.receiver,
    asset: `qie-erc20:${input.assetAddress}`,
    amount: input.amountBaseUnits,
    service_type: "credit-score",
    request_hash: hashObject({
      method: "GET",
      route: "/v1/x402/qie/credit-score/:agentId",
      agent_id: input.agentId,
    }),
    result_hash: hashObject(input.report),
    payment_proof_hash: hashObject({
      network: input.network,
      transaction,
      payer,
      receiver: input.receiver,
      amount_base_units: input.amountBaseUnits,
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
    // QIE settlement is provisional until independently confirmed against the
    // configured QIE RPC (no Indexer-equivalent is confirmed to exist); only
    // finalized receipts affect credit signals.
    const anchored = ctx.ledger.anchorExternalReceipt(envelope, { finalize: false });
    persistExternalReceiptProof(ctx, anchored.receipt_id);
    return anchored;
  } catch {
    // Payment delivery must not fail if the local/indexing layer is
    // temporarily unavailable. The on-chain transaction remains canonical.
    return null;
  }
}

export function finalizeQieExternalReceipt(ctx: QieAnchorContext, receiptId: string): void {
  ctx.ledger.finalizeExternalReceipt(receiptId);
  persistExternalReceiptProof(ctx, receiptId);
}

export function challengeQieExternalReceipt(ctx: QieAnchorContext, receiptId: string): void {
  ctx.ledger.challengeExternalReceipt(receiptId);
  persistExternalReceiptProof(ctx, receiptId);
}

/** Public, aggregate-only usage proof for the QIE challenge endpoint. */
export function qieX402Usage(ctx: QieAnchorContext, network: string, assetAddress: string) {
  const asset = `qie-erc20:${assetAddress}`;
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
  const totalBaseUnits = receipts.reduce(
    (total, receipt) => total + BigInt(receipt.amount),
    0n,
  );

  return {
    schema_version: "cred402.qie-x402-usage.v1",
    network,
    asset_address: assetAddress,
    paid_requests: receipts.length,
    unique_payers: new Set(receipts.map((receipt) => receipt.payer_agent_id)).size,
    total_base_units: totalBaseUnits.toString(),
    latest_payment_at: receipts[0]
      ? new Date(receipts[0].anchored_at * 1000).toISOString()
      : null,
    latest_receipts: receipts.slice(0, 10).map((receipt) => ({
      receipt_id: receipt.receipt_id,
      transaction: receipt.settlement_tx_hash,
      amount_base_units: receipt.amount,
      anchored_at: new Date(receipt.anchored_at * 1000).toISOString(),
    })),
  };
}

export function persistExternalReceiptProof(ctx: QieAnchorContext, receiptId: string): void {
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
