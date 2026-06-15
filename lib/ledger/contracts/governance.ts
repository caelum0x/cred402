import type { GovernanceParams, ParameterChange } from "../../core/protocol_types.js";
import { deployHash } from "../../core/hash.js";
import { cspr } from "../../core/units.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "Governance";

/**
 * Governance (p2 §6.11) — controls protocol parameters, fees and emergency pause
 * flags, with a public, append-only parameter history. In production this sits
 * behind a timelock + multisig; here it records every change for auditability.
 */
export class Governance {
  private params: GovernanceParams = {
    protocol_fee_bps: 50, // 0.5% protocol fee on interest
    origination_fee_bps: 100, // 1% origination fee on a new credit line
    min_reputation_to_draw: 40,
    max_agent_exposure: cspr(500),
    dispute_window_seconds: 86_400,
    paused_credit_draws: false,
    paused_registrations: false,
    paused_receipt_finalization: false,
  };
  private readonly history: ParameterChange[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  get(): GovernanceParams {
    return { ...this.params };
  }

  set_param<K extends keyof GovernanceParams>(key: K, value: GovernanceParams[K]): void {
    const previous = this.params[key];
    this.params = { ...this.params, [key]: value };
    const change: ParameterChange = {
      key,
      previous: String(previous),
      next: String(value),
      timestamp: this.clock.now(),
    };
    this.history.push(change);
    this.bus.emit("GovernanceParameterUpdated", CONTRACT, deployHash(), { key, previous: change.previous, next: change.next });
  }

  pause(area: "credit_draws" | "registrations" | "receipt_finalization"): void {
    const map = {
      credit_draws: "paused_credit_draws",
      registrations: "paused_registrations",
      receipt_finalization: "paused_receipt_finalization",
    } as const;
    this.set_param(map[area], true);
    this.bus.emit("ProtocolPaused", CONTRACT, deployHash(), { area });
  }

  unpause(area: "credit_draws" | "registrations" | "receipt_finalization"): void {
    const map = {
      credit_draws: "paused_credit_draws",
      registrations: "paused_registrations",
      receipt_finalization: "paused_receipt_finalization",
    } as const;
    this.set_param(map[area], false);
    this.bus.emit("ProtocolUnpaused", CONTRACT, deployHash(), { area });
  }

  parameterHistory(): ParameterChange[] {
    return [...this.history];
  }
}
