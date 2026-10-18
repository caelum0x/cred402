/**
 * Minimal QIE JSON-RPC client. QIE is EVM-compatible (Cosmos SDK consensus +
 * `eth_*` JSON-RPC), so a handful of standard Ethereum JSON-RPC methods are
 * enough: `eth_chainId` (network identity check) and
 * `eth_getTransactionReceipt` / `eth_blockNumber` (independent settlement
 * finality, mirroring the role `algorand_finality.ts` plays for the Algorand
 * Indexer — except QIE has no documented Indexer-equivalent, so Cred402 reads
 * its own configured RPC directly instead of a third-party API).
 *
 * Deliberately dependency-free (plain `fetch`), matching the rest of
 * Cred402's "real-behind-env" integrations.
 */

export interface QieRpcOptions {
  rpcUrl: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class QieRpcError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "QieRpcError";
  }
}

export interface QieTransactionReceipt {
  transactionHash: string;
  status: "0x0" | "0x1" | string;
  blockNumber: string; // hex
  from: string;
  to: string | null;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

/** Thin JSON-RPC 2.0 client for a single QIE endpoint (testnet or mainnet). */
export class QieRpcClient {
  private readonly rpcUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(opts: QieRpcOptions) {
    this.rpcUrl = opts.rpcUrl;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** `eth_chainId` — used to confirm the configured RPC actually serves the
   * expected QIE network before trusting it for settlement finality. */
  async chainId(): Promise<string> {
    return this.call<string>("eth_chainId", []);
  }

  async blockNumber(): Promise<bigint> {
    const hex = await this.call<string>("eth_blockNumber", []);
    return BigInt(hex);
  }

  async getTransactionReceipt(txHash: string): Promise<QieTransactionReceipt | null> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      throw new QieRpcError(`invalid transaction hash: ${txHash}`);
    }
    return this.call<QieTransactionReceipt | null>("eth_getTransactionReceipt", [txHash]);
  }

  /** ERC-20 `balanceOf(address)` via `eth_call` — no ABI library required for
   * a single 4-byte-selector read. */
  async erc20BalanceOf(token: string, account: string): Promise<bigint> {
    const selector = "0x70a08231"; // balanceOf(address)
    const paddedAccount = account.replace(/^0x/, "").toLowerCase().padStart(64, "0");
    const data = `${selector}${paddedAccount}`;
    const result = await this.call<string>("eth_call", [{ to: token, data }, "latest"]);
    return BigInt(result);
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new QieRpcError(`QIE RPC ${method} -> HTTP ${res.status}`);
      const body = (await res.json()) as { result?: T; error?: { message?: string; code?: number } };
      if (body.error) throw new QieRpcError(`QIE RPC ${method} -> ${body.error.message ?? "unknown RPC error"}`);
      return body.result as T;
    } catch (error) {
      if (error instanceof QieRpcError) throw error;
      if ((error as Error).name === "AbortError") {
        throw new QieRpcError(`QIE RPC ${method} timed out after ${this.timeoutMs}ms`);
      }
      throw new QieRpcError(`QIE RPC ${method} failed: ${error instanceof Error ? error.message : String(error)}`, error);
    } finally {
      clearTimeout(timer);
    }
  }
}
