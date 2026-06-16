/**
 * Casper JSON-RPC client (read path) — dependency-free over `fetch`.
 *
 * The READ side of going live needs no SDK: a Casper node exposes a JSON-RPC 2.0
 * endpoint, and these calls (state root hash, global-state queries, deploy
 * results, node status) are plain HTTP. This is real and runs against any node;
 * the WRITE side (signing + CL byte serialization) is the thin part the SDK
 * supplies via an injected signer (see transport.ts).
 */

export interface CasperRpcOptions {
  nodeAddress: string; // e.g. https://rpc.testnet.casperlabs.io/rpc
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export class CasperRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export class CasperRpcClient {
  private id = 0;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: CasperRpcOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Raw JSON-RPC call with timeout + error mapping. */
  async call<T>(method: string, params: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.opts.nodeAddress, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new CasperRpcError(`http ${res.status} from node`);
      const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new CasperRpcError(body.error.message, body.error.code);
      if (body.result === undefined) throw new CasperRpcError("empty result");
      return body.result;
    } catch (err) {
      if (err instanceof CasperRpcError) throw err;
      if ((err as Error).name === "AbortError") throw new CasperRpcError(`node timeout after ${this.timeoutMs}ms`);
      throw new CasperRpcError((err as Error).message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Current global state root hash (needed to scope queries). */
  async getStateRootHash(): Promise<string> {
    const r = await this.call<{ state_root_hash: string }>("chain_get_state_root_hash", {});
    return r.state_root_hash;
  }

  /** Query a key (+ optional path) under a state root — contract named keys / dict. */
  async queryGlobalState(key: string, path: string[] = [], stateRootHash?: string): Promise<unknown> {
    const root = stateRootHash ?? (await this.getStateRootHash());
    const r = await this.call<{ stored_value: unknown }>("query_global_state", {
      state_identifier: { StateRootHash: root },
      key,
      path,
    });
    return r.stored_value;
  }

  /** Result of a submitted deploy (execution success / failure + cost). */
  async getDeploy(deployHash: string): Promise<unknown> {
    return this.call("info_get_deploy", { deploy_hash: deployHash });
  }

  /** Node status (chainspec name, build, peers) — a cheap liveness/health probe. */
  async getNodeStatus(): Promise<{ chainspec_name?: string; build_version?: string }> {
    return this.call("info_get_status", {});
  }
}
