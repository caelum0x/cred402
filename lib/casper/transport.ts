import { CasperRpcClient } from "./rpc.js";
import type { DeploySpec } from "./deploy.js";

/**
 * CasperTransport — the seam between Cred402 and Casper.
 *
 * The in-memory {@link Ledger} and a live-network transport implement the same
 * interface, so swapping the ledger simulation for Testnet is a transport swap,
 * not a rewrite (ROADMAP "path to mainnet"). Reads run over JSON-RPC with no SDK;
 * writes go through an injected {@link DeploySigner} — the ONE place casper-js-sdk
 * is needed (it serializes + signs the deploy). That keeps this layer runnable
 * and testable offline while remaining a faithful production path.
 */

export interface DeployResult {
  deployHash: string;
  status: "submitted" | "success" | "failure";
  cost?: string;
  errorMessage?: string;
}

/** The casper-js-sdk-backed signer/submitter (injected, never hard-imported). */
export interface DeploySigner {
  /** Serialize + sign the spec into a deploy and submit it; returns the deploy hash. */
  signAndSubmit(spec: DeploySpec): Promise<string>;
}

export interface CasperTransport {
  callEntryPoint(spec: DeploySpec): Promise<DeployResult>;
  queryContractKey(contractHash: string, path: string[]): Promise<unknown>;
  waitForDeploy(deployHash: string, opts?: { timeoutMs?: number; pollMs?: number }): Promise<DeployResult>;
  health(): Promise<{ ok: boolean; chain?: string }>;
}

export class CasperRpcTransport implements CasperTransport {
  constructor(
    private readonly rpc: CasperRpcClient,
    private readonly signer: DeploySigner,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async callEntryPoint(spec: DeploySpec): Promise<DeployResult> {
    const deployHash = await this.signer.signAndSubmit(spec);
    return { deployHash, status: "submitted" };
  }

  async queryContractKey(contractHash: string, path: string[]): Promise<unknown> {
    const key = contractHash.startsWith("hash-") ? contractHash.replace("hash-", "hash-") : contractHash;
    return this.rpc.queryGlobalState(key, path);
  }

  /** Poll the deploy result until executed (or timeout). */
  async waitForDeploy(deployHash: string, opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<DeployResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const pollMs = opts.pollMs ?? 4_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = (await this.rpc.getDeploy(deployHash)) as {
        execution_results?: Array<{ result?: { Success?: { cost?: string }; Failure?: { error_message?: string; cost?: string } } }>;
      };
      const result = raw.execution_results?.[0]?.result;
      if (result?.Success) return { deployHash, status: "success", cost: result.Success.cost };
      if (result?.Failure) return { deployHash, status: "failure", cost: result.Failure.cost, errorMessage: result.Failure.error_message };
      await this.sleep(pollMs);
    }
    return { deployHash, status: "submitted", errorMessage: "timed out waiting for execution" };
  }

  async health(): Promise<{ ok: boolean; chain?: string }> {
    try {
      const status = await this.rpc.getNodeStatus();
      return { ok: true, chain: status.chainspec_name };
    } catch {
      return { ok: false };
    }
  }
}
