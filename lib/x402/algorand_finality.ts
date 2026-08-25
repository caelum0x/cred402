export type AlgorandFinalityResult =
  | {
      status: "confirmed" | "pending";
      confirmedRound: number;
      currentRound: number;
      confirmations: number;
    }
  | { status: "not_found" }
  | { status: "mismatch"; reason: string }
  | { status: "unavailable"; reason: string };

export interface AlgorandFinalityConfig {
  indexerUrl: string;
  indexerToken?: string;
  timeoutMs: number;
  minimumRounds: number;
}

interface IndexerTransactionResponse {
  "current-round"?: unknown;
  transaction?: {
    id?: unknown;
    sender?: unknown;
    "confirmed-round"?: unknown;
    "tx-type"?: unknown;
    "asset-transfer-transaction"?: {
      amount?: unknown;
      "asset-id"?: unknown;
      receiver?: unknown;
    };
  };
}

const ALGORAND_TX_ID = /^[A-Z2-7]{52}$/;

/** Verify a facilitator-returned transfer against the configured Algorand Indexer. */
export async function verifyAlgorandAssetTransfer(
  config: AlgorandFinalityConfig,
  expected: {
    transaction: string;
    payer: string;
    receiver: string;
    asset: number;
    amountMicroUsdc: string;
  },
): Promise<AlgorandFinalityResult> {
  if (!ALGORAND_TX_ID.test(expected.transaction)) {
    return { status: "mismatch", reason: "facilitator returned an invalid Algorand transaction id" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(
      `${config.indexerUrl}/v2/transactions/${encodeURIComponent(expected.transaction)}`,
      {
        headers: config.indexerToken ? { "X-Indexer-API-Token": config.indexerToken } : undefined,
        redirect: "error",
        signal: controller.signal,
      },
    );
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) {
      return { status: "unavailable", reason: `Algorand Indexer returned HTTP ${response.status}` };
    }

    const body = await response.json() as IndexerTransactionResponse;
    const transaction = body.transaction;
    const transfer = transaction?.["asset-transfer-transaction"];
    const confirmedRound = integer(transaction?.["confirmed-round"]);
    const currentRound = integer(body["current-round"]);
    const amount = unsignedIntegerString(transfer?.amount);
    const asset = integer(transfer?.["asset-id"]);

    if (transaction?.id !== expected.transaction) {
      return { status: "mismatch", reason: "Indexer transaction id does not match settlement" };
    }
    if (transaction?.sender !== expected.payer) {
      return { status: "mismatch", reason: "Indexer sender does not match the verified payer" };
    }
    if (transaction?.["tx-type"] !== "axfer" || !transfer) {
      return { status: "mismatch", reason: "Settlement is not an Algorand asset transfer" };
    }
    if (transfer.receiver !== expected.receiver) {
      return { status: "mismatch", reason: "Indexer receiver does not match the configured pay-to address" };
    }
    if (asset !== expected.asset) {
      return { status: "mismatch", reason: "Indexer asset does not match configured USDC" };
    }
    if (amount !== expected.amountMicroUsdc) {
      return { status: "mismatch", reason: "Indexer transfer amount does not match the x402 requirement" };
    }
    if (confirmedRound === undefined || currentRound === undefined || confirmedRound <= 0) {
      return { status: "unavailable", reason: "Indexer response is missing confirmed round data" };
    }

    const confirmations = Math.max(0, currentRound - confirmedRound + 1);
    return {
      status: confirmations >= config.minimumRounds ? "confirmed" : "pending",
      confirmedRound,
      currentRound,
      confirmations,
    };
  } catch (error) {
    return {
      status: "unavailable",
      reason: error instanceof Error ? error.message : "Algorand Indexer request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

function integer(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function unsignedIntegerString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value).toString();
  return undefined;
}
