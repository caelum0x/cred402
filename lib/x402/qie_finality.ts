import { QieRpcClient, QieRpcError } from "./qie_rpc.js";

/**
 * Independent settlement finality for QIE x402 payments.
 *
 * The Algorand integration double-checks the facilitator's reported
 * settlement against an independent Indexer before counting revenue or
 * reputation (`algorand_finality.ts`). QIE has no documented Indexer-grade
 * REST API confirmed by research, so Cred402 reads its own configured RPC
 * directly: it re-fetches the transaction receipt, confirms it succeeded,
 * confirms an ERC-20 `Transfer(address,address,uint256)` log moved at least
 * the expected amount to the configured receiver from the configured asset
 * contract, and requires a minimum confirmation depth before calling the
 * receipt `confirmed`.
 */

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface QieFinalityCheck {
  status: "pending" | "confirmed" | "not_found" | "mismatch" | "unavailable";
  checkedAt: string;
  confirmations?: number;
  currentBlock?: string;
  reason?: string;
}

function topicToAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

function sameAddress(a: string | null | undefined, b: string): boolean {
  return !!a && a.toLowerCase() === b.toLowerCase();
}

export async function verifyQieAssetTransfer(
  rpc: { rpcUrl: string; timeoutMs: number; minimumConfirmations: number; fetchFn?: typeof fetch },
  settlement: { transaction: string; asset: string; receiver: string; amountBaseUnits: string },
): Promise<QieFinalityCheck> {
  const client = new QieRpcClient({ rpcUrl: rpc.rpcUrl, timeoutMs: rpc.timeoutMs, fetchFn: rpc.fetchFn });
  const checkedAt = new Date().toISOString();
  try {
    const [receipt, currentBlockNumber] = await Promise.all([
      client.getTransactionReceipt(settlement.transaction),
      client.blockNumber(),
    ]);
    if (!receipt) {
      return { status: "not_found", checkedAt, reason: "Transaction not yet visible at the configured RPC" };
    }
    if (receipt.status !== "0x1") {
      return { status: "mismatch", checkedAt, reason: `Transaction reverted (status ${receipt.status})` };
    }
    const expectedAmount = BigInt(settlement.amountBaseUnits);
    const matchingTransfer = receipt.logs.find((log) => {
      if (!sameAddress(log.address, settlement.asset)) return false;
      if (log.topics[0] !== ERC20_TRANSFER_TOPIC || log.topics.length < 3) return false;
      const to = topicToAddress(log.topics[2]!);
      if (!sameAddress(to, settlement.receiver)) return false;
      return BigInt(log.data) >= expectedAmount;
    });
    if (!matchingTransfer) {
      return {
        status: "mismatch",
        checkedAt,
        reason: "No matching ERC-20 Transfer log to the configured receiver for at least the expected amount",
      };
    }
    const receiptBlock = BigInt(receipt.blockNumber);
    const confirmations = Number(currentBlockNumber - receiptBlock + 1n);
    const status = confirmations >= rpc.minimumConfirmations ? "confirmed" : "pending";
    return { status, checkedAt, confirmations, currentBlock: currentBlockNumber.toString() };
  } catch (error) {
    return {
      status: "unavailable",
      checkedAt,
      reason: error instanceof QieRpcError ? error.message : error instanceof Error ? error.message : "unknown RPC error",
    };
  }
}
