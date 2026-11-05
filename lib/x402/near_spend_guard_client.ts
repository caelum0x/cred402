import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { isValidNearAccountId } from "./near_networks.js";

/**
 * near_spend_guard_client.ts — a typed client for the real, deployed
 * `contracts-near/spend_guard` NEAR contract (NEAR Hackathon 2026, Agent
 * Economy / AI Security & Defense tracks).
 *
 * Mirrors the config-loader + typed-result style of `near_gateway.ts`
 * (`loadNearX402Config` / `NearX402ConfigResult`), but talks to the NEW
 * SpendGuard contract instead of the pre-existing x402 payment-rail
 * endpoints — this file does not modify or re-wrap `near_gateway.ts`,
 * `near_rpc.ts`, or `near_finality.ts`.
 *
 * Deployed via `scripts/near_spend_guard_deploy.ts` (real NEAR Testnet
 * deploy, driven programmatically through `near-api-js` rather than the
 * interactive `cargo near` CLI — see that script's header comment).
 */

export interface SpendGuardConfig {
  contractId: string;
  rpcUrl: string;
}

export type SpendGuardConfigResult =
  | { enabled: true; config: SpendGuardConfig }
  | { enabled: false; reason: string };

/** Load the SpendGuard client config from the environment. Fails closed. */
export function loadSpendGuardConfig(env: NodeJS.ProcessEnv = process.env): SpendGuardConfigResult {
  const contractId = env.CRED402_NEAR_SPEND_GUARD_CONTRACT?.trim();
  if (!contractId) {
    return { enabled: false, reason: "CRED402_NEAR_SPEND_GUARD_CONTRACT is required (see scripts/near_spend_guard_deploy.ts)" };
  }
  if (!isValidNearAccountId(contractId)) {
    return { enabled: false, reason: "CRED402_NEAR_SPEND_GUARD_CONTRACT is not a valid NEAR account id" };
  }
  // See `near_networks.ts::DEFAULT_NEAR_RPC_URL` for why this defaults to
  // FastNear rather than NEAR's own now-rate-limited legacy public RPC.
  const rpcUrl = env.CRED402_NEAR_RPC_URL?.trim() || "https://rpc.testnet.fastnear.com";
  return { enabled: true, config: { contractId, rpcUrl } };
}

/** Policy inputs — mirrors `contracts-near/spend_guard/src/policy.rs::AgentMetrics`. */
export interface SpendGuardAgentMetrics {
  /** Verified 30-day x402 revenue, in yoctoNEAR (decimal string — U128 ABI). */
  revenue_30d: string;
  /** Staked collateral, in yoctoNEAR (decimal string). */
  stake: string;
  dispute_rate_bps: number;
  accuracy_score: number;
  total_jobs: number;
}

export interface SpendGuardAgentRecord {
  agent_id: string;
  sub_account: string;
  public_key: string;
  credit_line: string;
  credit_score: number;
  interest_rate_bps: number;
  policy_version: number;
  key_active: boolean;
}

export interface SpendGuardAgentExposure {
  agent_id: string;
  outstanding: string;
  reserved: string;
  max_allowed: string;
  frozen: boolean;
  updated_at: number;
}

/**
 * SpendGuardClient — talks to the deployed contract using a given
 * `near-api-js` `Account` as the caller. Construct one client per signer
 * (the admin/operator for authorization + dispute-spike calls, one per
 * agent sub-key for `spendToSeller`).
 */
export class SpendGuardClient {
  constructor(
    private readonly config: SpendGuardConfig,
    private readonly caller: Account,
  ) {}

  /** Build a client whose caller signs with a raw NEAR secret key string
   * (`ed25519:...`), acting as the given `signerAccountId` (which may be
   * the SpendGuard contract's own account, for a scoped per-agent spend
   * key — see `spend_key.rs`'s module docs for why). */
  static withSecretKey(config: SpendGuardConfig, signerAccountId: string, secretKey: KeyPairString): SpendGuardClient {
    const provider = new JsonRpcProvider({ url: config.rpcUrl });
    const account = new Account(signerAccountId, provider, secretKey);
    return new SpendGuardClient(config, account);
  }

  /** Admin/operator-only: evaluate policy against independently-verified
   * metrics and mint the agent a real, capped Function Call Access Key.
   * Returns once every receipt in the resulting promise chain (identity
   * sub-account creation + key minting) has finalized. */
  async requestSpendAuthorization(args: {
    agentId: string;
    metrics: SpendGuardAgentMetrics;
    publicKey: string;
  }): Promise<unknown> {
    return this.caller.callFunction({
      contractId: this.config.contractId,
      methodName: "request_spend_authorization",
      args: { agent_id: args.agentId, metrics: args.metrics, public_key: args.publicKey },
      gas: 150_000_000_000_000n,
    });
  }

  /** Spend-key-only: forward `amountYocto` to `sellerId` out of the
   * contract's pooled balance, debited against the signer's own exposure.
   * The caller account MUST be constructed with the per-agent scoped
   * secret key (see `withSecretKey`, signer = the SpendGuard contract's
   * own account id) — this is the call nearcore will reject once the
   * key's allowance is exhausted or its agent is frozen, not an
   * application-level check. */
  async spendToSeller(args: { sellerId: string; amountYocto: string }): Promise<unknown> {
    return this.caller.callFunction({
      contractId: this.config.contractId,
      methodName: "spend_to_seller",
      args: { seller_id: args.sellerId, amount: args.amountYocto },
      gas: 15_000_000_000_000n,
    });
  }

  /** Admin-only: record a real repayment against `agentId`'s outstanding
   * draw, freeing that much headroom back under its global exposure cap —
   * the other half of `spendToSeller`'s draw-down (see
   * `contracts-near/spend_guard/src/lib.rs::repay_credit_line`). Moves no
   * funds itself; the admin has independently verified a real repayment
   * happened (e.g. against the agent's later x402 revenue) before calling
   * this. */
  async repayCreditLine(args: { agentId: string; amountYocto: string }): Promise<unknown> {
    return this.caller.callFunction({
      contractId: this.config.contractId,
      methodName: "repay_credit_line",
      args: { agent_id: args.agentId, amount: args.amountYocto },
      gas: 30_000_000_000_000n,
    });
  }

  /** Admin-only (added 2026-11-05): re-authorize additional spend headroom
   * for an agent that already has a live, non-frozen key — the entrypoint
   * that makes `repayCreditLine` an actually reachable revolving credit
   * line end to end: draw -> repay -> top up -> draw again, on the SAME
   * still-active key, never minting a new identity or a new public key
   * (see `contracts-near/spend_guard/src/lib.rs::top_up_allowance`). Under
   * the hood this re-mints the agent's existing Function Call Access Key
   * (delete + re-add in the same receipt — nearcore refuses a second
   * `AddKey` for an existing public key) with an allowance equal to its
   * new total reserved headroom, capped by the agent's own
   * policy-approved credit line. */
  async topUpAllowance(args: { agentId: string; amountYocto: string }): Promise<unknown> {
    return this.caller.callFunction({
      contractId: this.config.contractId,
      methodName: "top_up_allowance",
      args: { agent_id: args.agentId, amount: args.amountYocto },
      // Covers both actions in the delete+re-add receipt (see
      // `retop_spend_key`) with the same headroom as the two-promise
      // `requestSpendAuthorization` call above.
      gas: 150_000_000_000_000n,
    });
  }

  /** Admin/watchdog-only (Day 6): record a dispute-rate spike. Crossing
   * the threshold freezes exposure and revokes the agent's live spend key
   * via a real `delete_key` promise. */
  async reportDisputeSpike(args: { agentId: string; count: number }): Promise<unknown> {
    return this.caller.callFunction({
      contractId: this.config.contractId,
      methodName: "report_dispute_spike",
      args: { agent_id: args.agentId, count: args.count },
      gas: 100_000_000_000_000n,
    });
  }

  async getAgent(agentId: string): Promise<SpendGuardAgentRecord | null> {
    const result = await this.caller.provider.callFunction<SpendGuardAgentRecord>({
      contractId: this.config.contractId,
      method: "get_agent",
      args: { agent_id: agentId },
    });
    return result ?? null;
  }

  async getExposure(agentId: string): Promise<SpendGuardAgentExposure | null> {
    const result = await this.caller.provider.callFunction<SpendGuardAgentExposure>({
      contractId: this.config.contractId,
      method: "get_exposure",
      args: { agent_id: agentId },
    });
    return result ?? null;
  }

  async remainingAllowance(agentId: string): Promise<string | null> {
    const result = await this.caller.provider.callFunction<string>({
      contractId: this.config.contractId,
      method: "remaining_allowance",
      args: { agent_id: agentId },
    });
    return result ?? null;
  }

  async getDisputeCount(agentId: string): Promise<number> {
    const result = await this.caller.provider.callFunction<number>({
      contractId: this.config.contractId,
      method: "get_dispute_count",
      args: { agent_id: agentId },
    });
    return result ?? 0;
  }
}

/** Generate a fresh ed25519 keypair for a new agent's spend key (offline,
 * no network call, nothing spent — same pattern as `scripts/near_keygen.ts`). */
export function generateSpendKeyPair(): { publicKey: string; secretKey: KeyPairString } {
  const keyPair = KeyPair.fromRandom("ed25519");
  return { publicKey: keyPair.getPublicKey().toString(), secretKey: keyPair.toString() as KeyPairString };
}
