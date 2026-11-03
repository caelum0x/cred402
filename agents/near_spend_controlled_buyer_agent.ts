import {
  SpendGuardClient,
  generateSpendKeyPair,
  loadSpendGuardConfig,
  type SpendGuardAgentMetrics,
  type SpendGuardConfig,
} from "../lib/x402/near_spend_guard_client.js";
import type { KeyPairString } from "near-api-js";

/**
 * NearSpendControlledBuyerAgent (Day 5) — the `agents/buyer_agent.ts`
 * pattern applied to the real, deployed SpendGuard contract instead of the
 * Casper ledger: an autonomous agent that gets evaluated against its real
 * x402 revenue, receives a sandboxed, protocol-capped NEAR spend key, pays
 * a seller repeatedly through it, and proves the cap is enforced by
 * nearcore itself once it's exhausted.
 *
 * Unlike `BuyerAgent` (which owns a Casper-style ed25519 keypair as its own
 * on-chain identity), this agent's "identity" for spending purposes is a
 * Function Call Access Key added to the SpendGuard CONTRACT's own account
 * — see `contracts-near/spend_guard/src/spend_key.rs` for why that is the
 * protocol-correct design, not a simplification. The agent still generates
 * its own ed25519 keypair locally (`generateSpendKeyPair`, same pattern as
 * `scripts/near_keygen.ts`); it is just registered as a scoped key on the
 * contract rather than as a new account's full key.
 */
export interface SpendResult {
  attempt: number;
  success: boolean;
  detail: string;
}

export class NearSpendControlledBuyerAgent {
  readonly agentId: string;
  readonly publicKey: string;
  private readonly secretKey: KeyPairString;
  private spendClient?: SpendGuardClient;

  constructor(
    private readonly config: SpendGuardConfig,
    agentId: string,
  ) {
    this.agentId = agentId;
    const { publicKey, secretKey } = generateSpendKeyPair();
    this.publicKey = publicKey;
    this.secretKey = secretKey;
  }

  /** Admin/operator step: evaluate this agent's real metrics and mint its
   * capped spend key. In production, `metrics` would be computed
   * server-side from this agent's finalized x402 receipts
   * (`near_payment_attempt_store.ts`), never accepted from the agent
   * itself — `adminClient` must be a `SpendGuardClient` built with the
   * contract operator's own full-access key. */
  async getAuthorized(adminClient: SpendGuardClient, metrics: SpendGuardAgentMetrics): Promise<void> {
    await adminClient.requestSpendAuthorization({ agentId: this.agentId, metrics, publicKey: this.publicKey });
  }

  /** The agent's own client, signing with ONLY its scoped spend key, acting
   * as the SpendGuard contract's account (not its own) — this is the
   * sandboxed wallet. Lazily constructed so it is only ever built after
   * `getAuthorized` has actually minted the key on-chain. */
  private asSpender(): SpendGuardClient {
    if (!this.spendClient) {
      this.spendClient = SpendGuardClient.withSecretKey(this.config, this.config.contractId, this.secretKey);
    }
    return this.spendClient;
  }

  /** Pay `sellerId` `amountYocto` repeatedly, `maxAttempts` times or until
   * nearcore itself rejects the call (allowance exhausted or key revoked).
   * Returns every attempt's outcome — the caller decides what "success"
   * means for the demo (Day 5 wants to see the FIRST rejection and prove
   * it's protocol-level, not application-level). */
  async spendRepeatedly(sellerId: string, amountYocto: string, maxAttempts: number): Promise<SpendResult[]> {
    const client = this.asSpender();
    const results: SpendResult[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await client.spendToSeller({ sellerId, amountYocto });
        results.push({ attempt, success: true, detail: "settled" });
      } catch (error) {
        results.push({ attempt, success: false, detail: errorDetail(error) });
        break;
      }
    }
    return results;
  }

  async remainingAllowance(adminClient: SpendGuardClient): Promise<string | null> {
    return adminClient.remainingAllowance(this.agentId);
  }
}

function errorDetail(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** CLI entry point for a standalone real-network run, mirroring the
 * `scripts/steps.ts` demo-step pattern. Requires
 * `CRED402_NEAR_SPEND_GUARD_CONTRACT` and
 * `CRED402_NEAR_SPEND_GUARD_ADMIN_SECRET_KEY` (the deployer's own key, from
 * `.secrets/near_spend_guard_credentials.json`). */
async function main(): Promise<void> {
  const result = loadSpendGuardConfig();
  if (!result.enabled) {
    console.error(result.reason);
    process.exit(1);
  }
  const adminSecretKey = process.env.CRED402_NEAR_SPEND_GUARD_ADMIN_SECRET_KEY?.trim() as KeyPairString | undefined;
  if (!adminSecretKey) {
    console.error("CRED402_NEAR_SPEND_GUARD_ADMIN_SECRET_KEY is required to run this demo against the real deploy");
    process.exit(1);
  }
  const adminClient = SpendGuardClient.withSecretKey(result.config, result.config.contractId, adminSecretKey);
  const agent = new NearSpendControlledBuyerAgent(result.config, `demo-buyer-${Date.now()}`);

  console.log(`Authorizing ${agent.agentId} with public key ${agent.publicKey}...`);
  await agent.getAuthorized(adminClient, {
    revenue_30d: "100000000000000000000000", // 0.1 NEAR
    stake: "0",
    dispute_rate_bps: 0,
    accuracy_score: 100,
    total_jobs: 10,
  });

  const record = await adminClient.getAgent(agent.agentId);
  console.log("agent record:", record);

  const sellerId = process.env.CRED402_NEAR_SPEND_GUARD_SELLER ?? result.config.contractId;
  const results = await agent.spendRepeatedly(sellerId, "1", 50);
  console.log("spend results:", results);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
