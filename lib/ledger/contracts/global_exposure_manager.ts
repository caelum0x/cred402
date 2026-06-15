import { deployHash } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "GlobalExposureManager";

/** Exposure is tracked in normalized USD micro-units (1 USD = 1_000_000). */
export interface AgentExposure {
  agent_id: string;
  outstanding: bigint;
  reserved: bigint;
  max_allowed: bigint;
  frozen: boolean;
  updated_at: number;
}

/**
 * GlobalExposureManager (p3) — the contract that prevents the killer multichain
 * failure mode: an agent borrowing the same credit on Casper, EVM, Solana and
 * Cosmos and defaulting everywhere. It tracks each agent's TOTAL credit exposure
 * across all chains and refuses reservations beyond the global cap.
 */
export class GlobalExposureManager {
  private readonly exposure = new Map<string, AgentExposure>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  ensure_agent(agent_id: string, max_allowed: bigint): AgentExposure {
    let e = this.exposure.get(agent_id);
    if (!e) {
      e = { agent_id, outstanding: 0n, reserved: 0n, max_allowed, frozen: false, updated_at: this.clock.now() };
      this.exposure.set(agent_id, e);
    } else if (max_allowed > e.max_allowed) {
      e.max_allowed = max_allowed; // can be raised by policy, never silently lowered below committed
    }
    return { ...e };
  }

  /** Reserve global exposure before issuing a Credit Authorization Note. */
  reserve_exposure(agent_id: string, amount: bigint): AgentExposure {
    const e = this.must(agent_id);
    if (e.frozen) throw new Error(`agent ${agent_id} exposure is frozen`);
    if (e.outstanding + e.reserved + amount > e.max_allowed) {
      throw new Error(
        `global exposure cap exceeded: ${e.outstanding + e.reserved + amount} > ${e.max_allowed} (agent ${agent_id})`,
      );
    }
    e.reserved += amount;
    e.updated_at = this.clock.now();
    this.bus.emit("ExposureReserved", CONTRACT, deployHash(), { agent_id, amount: amount.toString(), reserved: e.reserved.toString() });
    return { ...e };
  }

  /** A satellite confirmed a draw: move reservation into outstanding exposure. */
  activate_exposure(agent_id: string, amount: bigint): void {
    const e = this.must(agent_id);
    const moved = amount > e.reserved ? e.reserved : amount;
    e.reserved -= moved;
    e.outstanding += moved;
    e.updated_at = this.clock.now();
  }

  /** Release an unused reservation (CAN expired / not consumed). */
  release_reservation(agent_id: string, amount: bigint): void {
    const e = this.must(agent_id);
    e.reserved = amount > e.reserved ? 0n : e.reserved - amount;
    e.updated_at = this.clock.now();
    this.bus.emit("ExposureReleased", CONTRACT, deployHash(), { agent_id, amount: amount.toString() });
  }

  /** A satellite reported a repayment: reduce outstanding exposure. */
  decrease_exposure(agent_id: string, amount: bigint): void {
    const e = this.must(agent_id);
    e.outstanding = amount > e.outstanding ? 0n : e.outstanding - amount;
    e.updated_at = this.clock.now();
    this.bus.emit("ExposureReleased", CONTRACT, deployHash(), { agent_id, amount: amount.toString(), kind: "repayment" });
  }

  freeze_agent_exposure(agent_id: string): void {
    const e = this.must(agent_id);
    e.frozen = true;
    e.updated_at = this.clock.now();
    this.bus.emit("ExposureFrozen", CONTRACT, deployHash(), { agent_id });
  }

  get_agent_global_exposure(agent_id: string): AgentExposure | undefined {
    const e = this.exposure.get(agent_id);
    return e ? { ...e } : undefined;
  }

  list(): AgentExposure[] {
    return [...this.exposure.values()].map((e) => ({ ...e }));
  }

  private must(agent_id: string): AgentExposure {
    const e = this.exposure.get(agent_id);
    if (!e) throw new Error(`no exposure record for agent ${agent_id}`);
    return e;
  }
}
