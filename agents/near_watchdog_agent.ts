import { SpendGuardClient, loadSpendGuardConfig } from "../lib/x402/near_spend_guard_client.js";
import type { KeyPairString } from "near-api-js";

/**
 * NearWatchdogAgent (Day 6) — the `agents/watchdog_agent.ts` pattern
 * applied to the real, deployed SpendGuard contract: monitors for a
 * dispute-rate spike on an agent and triggers the circuit breaker, which
 * freezes `ExposureBook` and deletes the agent's live spend key via a real
 * `delete_key` promise (see `contracts-near/spend_guard/src/scam_detection.rs`).
 *
 * Unlike `WatchdogAgent` (which reacts to a live Casper ledger event
 * stream), this agent is deliberately simple: it calls
 * `report_dispute_spike` directly, using the CONTRACT ADMIN's own full
 * access key — exactly the operator-trust model `request_spend_authorization`
 * already requires (see `lib.rs::only_admin`). A production watchdog would
 * derive the dispute count from real on-chain dispute signals instead of
 * being told a number directly; that data source does not exist for this
 * new contract yet (Day 7+ follow-up), so this agent's job here is the
 * enforcement action, not dispute detection.
 */
export class NearWatchdogAgent {
  constructor(private readonly adminClient: SpendGuardClient) {}

  /** Simulate (or relay a real) dispute-rate spike against `agentId`.
   * Crossing `scam_detection::DISPUTE_SPIKE_THRESHOLD` (3) freezes exposure
   * and revokes the key in the SAME on-chain call. */
  async reportDisputeSpike(agentId: string, count: number): Promise<void> {
    await this.adminClient.reportDisputeSpike({ agentId, count });
  }

  async isFrozen(agentId: string): Promise<boolean> {
    const exposure = await this.adminClient.getExposure(agentId);
    return exposure?.frozen ?? false;
  }

  async isKeyActive(agentId: string): Promise<boolean> {
    const record = await this.adminClient.getAgent(agentId);
    return record?.key_active ?? false;
  }
}

/** CLI entry point for a standalone real-network run — freezes whichever
 * `agent_id` is passed as argv[2] (or `CRED402_NEAR_SPEND_GUARD_TARGET_AGENT`). */
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
  const agentId = process.argv[2] ?? process.env.CRED402_NEAR_SPEND_GUARD_TARGET_AGENT;
  if (!agentId) {
    console.error("usage: tsx agents/near_watchdog_agent.ts <agent_id>");
    process.exit(1);
  }

  const adminClient = SpendGuardClient.withSecretKey(result.config, result.config.contractId, adminSecretKey);
  const watchdog = new NearWatchdogAgent(adminClient);

  console.log(`Simulating a dispute-rate spike (5 disputes) against ${agentId}...`);
  await watchdog.reportDisputeSpike(agentId, 5);

  console.log("frozen:", await watchdog.isFrozen(agentId));
  console.log("key_active:", await watchdog.isKeyActive(agentId));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
