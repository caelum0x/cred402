import { NearRpcClient, NearRpcError, type NearTransferAction } from "./near_rpc.js";

/**
 * Independent settlement verification for NEAR x402 payments.
 *
 * NEAR has no x402 facilitator (confirmed or otherwise) at the time of
 * writing, so Cred402 does not pretend one exists: the resource server is
 * its own facilitator. This module reads the configured NEAR RPC directly
 * — the same role `algorand_finality.ts` plays against the Algorand Indexer
 * and `qie_finality.ts` plays against the QIE RPC — to confirm a payer's
 * claimed transaction actually executed, actually transferred at least the
 * expected amount of native NEAR to the configured receiver, and (for the
 * `confirmed` status) has been included for a minimum number of blocks.
 */

export interface NearFinalityCheck {
  status: "pending" | "confirmed" | "not_found" | "mismatch" | "unavailable";
  checkedAt: string;
  confirmations?: number;
  currentHeight?: number;
  reason?: string;
}

function isTransferAction(action: unknown): action is NearTransferAction {
  return typeof action === "object" && action !== null && "Transfer" in action &&
    typeof (action as NearTransferAction).Transfer?.deposit === "string";
}

export async function verifyNearAssetTransfer(
  rpc: { rpcUrl: string; timeoutMs: number; minimumFinalityBlocks: number; fetchFn?: typeof fetch },
  settlement: { transaction: string; payer?: string; receiver: string; amountYocto: string },
): Promise<NearFinalityCheck> {
  const client = new NearRpcClient({ rpcUrl: rpc.rpcUrl, timeoutMs: rpc.timeoutMs, fetchFn: rpc.fetchFn });
  const checkedAt = new Date().toISOString();
  if (!settlement.payer) {
    return { status: "mismatch", checkedAt, reason: "No payer account id was recorded for this settlement" };
  }
  try {
    const outcome = await client.txStatus(settlement.transaction, settlement.payer);
    if (!outcome) {
      return { status: "not_found", checkedAt, reason: "Transaction not yet visible at the configured NEAR RPC" };
    }
    if (outcome.status.Failure) {
      return { status: "mismatch", checkedAt, reason: "Transaction execution failed on NEAR" };
    }
    if (outcome.transaction.signer_id !== settlement.payer) {
      return { status: "mismatch", checkedAt, reason: "Transaction signer does not match the declared payer" };
    }
    if (outcome.transaction.receiver_id !== settlement.receiver) {
      return { status: "mismatch", checkedAt, reason: "Transaction receiver does not match the configured pay-to account" };
    }
    const expected = BigInt(settlement.amountYocto);
    const matchingTransfer = outcome.transaction.actions.find(
      (action) => isTransferAction(action) && BigInt(action.Transfer.deposit) >= expected,
    );
    if (!matchingTransfer) {
      return {
        status: "mismatch",
        checkedAt,
        reason: "No Transfer action to the configured receiver moved at least the expected amount of yoctoNEAR",
      };
    }

    const [txBlock, finalBlock] = await Promise.all([
      client.blockByHash(outcome.transaction_outcome.block_hash),
      client.finalBlock(),
    ]);
    const confirmations = finalBlock.header.height - txBlock.header.height + 1;
    const status = confirmations >= rpc.minimumFinalityBlocks ? "confirmed" : "pending";
    return { status, checkedAt, confirmations, currentHeight: finalBlock.header.height };
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt,
      reason: error instanceof NearRpcError ? error.message : error instanceof Error ? error.message : "unknown RPC error",
    };
  }
}
