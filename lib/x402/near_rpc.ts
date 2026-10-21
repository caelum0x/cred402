/**
 * Minimal NEAR JSON-RPC client. Deliberately dependency-free (plain
 * `fetch`), matching `qie_rpc.ts` / the rest of Cred402's "real-behind-env"
 * integrations. Only the handful of NEAR JSON-RPC methods the x402 NEAR
 * settlement path needs are implemented:
 *
 *  - `EXPERIMENTAL_tx_status` — look up a transaction by hash + signer and
 *    read its outcome (`SuccessValue` / `Failure`) and the actions it
 *    executed.
 *  - `block` — read a block's height, either by hash (to locate where a
 *    transaction landed) or by `finality: "final"` (to read the current
 *    finalized height for a confirmation-depth check).
 *
 * Reference: https://docs.near.org/api/rpc/transactions and
 * https://docs.near.org/api/rpc/block-chunk
 */

export interface NearRpcOptions {
  rpcUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class NearRpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

export interface NearTransferAction {
  Transfer: { deposit: string };
}

export interface NearFunctionCallAction {
  FunctionCall: { method_name: string; args: string; gas: number; deposit: string };
}

export type NearTransactionAction = NearTransferAction | NearFunctionCallAction | Record<string, unknown>;

export interface NearTxStatusResult {
  status: { SuccessValue?: string; SuccessReceiptId?: string; Failure?: unknown };
  transaction: {
    signer_id: string;
    receiver_id: string;
    hash: string;
    actions: NearTransactionAction[];
  };
  transaction_outcome: {
    block_hash: string;
  };
}

export interface NearBlockResult {
  header: { height: number; hash: string };
}

/** Thin JSON-RPC 2.0 client for a single NEAR endpoint (testnet or mainnet). */
export class NearRpcClient {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: NearRpcOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Look up a transaction's final outcome. Returns `null` when NEAR has not
   * yet indexed the transaction (not an error — the payment may still be in flight). */
  async txStatus(txHash: string, senderAccountId: string): Promise<NearTxStatusResult | null> {
    try {
      return await this.call<NearTxStatusResult>("EXPERIMENTAL_tx_status", {
        tx_hash: txHash,
        sender_account_id: senderAccountId,
      });
    } catch (error) {
      if (error instanceof NearRpcError && /UNKNOWN_TRANSACTION|does not exist/i.test(error.message)) {
        return null;
      }
      throw error;
    }
  }

  async blockByHash(blockHash: string): Promise<NearBlockResult> {
    return this.call<NearBlockResult>("block", { block_id: blockHash });
  }

  async finalBlock(): Promise<NearBlockResult> {
    return this.call<NearBlockResult>("block", { finality: "final" });
  }

  private async call<T>(method: string, params: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "cred402", method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new NearRpcError(`NEAR RPC ${method} -> HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { name?: string; cause?: { name?: string }; message?: string } };
      if (body.error) {
        const name = body.error.cause?.name ?? body.error.name ?? "unknown RPC error";
        throw new NearRpcError(`NEAR RPC ${method} -> ${name}: ${body.error.message ?? ""}`.trim());
      }
      return body.result as T;
    } catch (error) {
      if (error instanceof NearRpcError) throw error;
      if ((error as Error).name === "AbortError") {
        throw new NearRpcError(`NEAR RPC ${method} timed out after ${this.timeoutMs}ms`);
      }
      throw new NearRpcError(`NEAR RPC ${method} failed: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}
