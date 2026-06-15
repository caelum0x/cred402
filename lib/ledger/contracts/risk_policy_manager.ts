import type { Agent } from "../../core/types.js";
import type { CreditDecision, PolicyFn } from "../../core/risk_policy.js";
import { POLICIES } from "../../core/risk_policy.js";
import { deployHash } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "RiskPolicyManager";

/**
 * RiskPolicyManager — holds the active underwriting policy version. Casper's
 * upgradable contracts let us swap v1 -> v2 without redeploying the registry or
 * pool. Mirrors `contracts/risk_policy_manager`.
 */
export class RiskPolicyManager {
  private activeVersion = "v1";

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  version(): string {
    return this.activeVersion;
  }

  /** Upgrade the active policy (the headline upgradable-contract demo). */
  upgrade(version: string): void {
    if (!POLICIES[version]) throw new Error(`unknown policy version: ${version}`);
    const previous = this.activeVersion;
    this.activeVersion = version;
    this.bus.emit("PolicyUpgraded", CONTRACT, deployHash(), { previous, current: version });
  }

  evaluate(agent: Agent): CreditDecision {
    const fn = this.policy();
    return fn(agent, this.clock.now());
  }

  private policy(): PolicyFn {
    const fn = POLICIES[this.activeVersion];
    if (!fn) throw new Error(`policy ${this.activeVersion} missing`);
    return fn;
  }
}
