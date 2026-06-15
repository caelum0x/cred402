import { deployHash } from "../../core/hash.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "UpgradeManager";

export interface ContractRecord {
  name: string;
  version: number;
  package_hash: string;
  wasm_hash: string;
  updated_at: number;
}

export interface UpgradeRecord {
  name: string;
  from_version: number;
  to_version: number;
  wasm_hash: string;
  timestamp: number;
}

/**
 * UpgradeManager (p3) — records the version + WASM hash of every deployed Casper
 * contract and the history of upgrades. Casper's upgradable-contracts story is a
 * first-class feature here: risk policy and satellite logic evolve without
 * redeploying the whole protocol, and every change is auditable.
 */
export class UpgradeManager {
  private readonly contracts = new Map<string, ContractRecord>();
  private readonly history: UpgradeRecord[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  register_contract(name: string, package_hash: string, wasm_hash: string): void {
    this.contracts.set(name, { name, version: 1, package_hash, wasm_hash, updated_at: this.clock.now() });
  }

  record_upgrade(name: string, wasm_hash: string): UpgradeRecord {
    const c = this.contracts.get(name);
    if (!c) throw new Error(`unknown contract ${name}`);
    const from = c.version;
    c.version += 1;
    c.wasm_hash = wasm_hash;
    c.updated_at = this.clock.now();
    const rec: UpgradeRecord = { name, from_version: from, to_version: c.version, wasm_hash, timestamp: this.clock.now() };
    this.history.push(rec);
    this.bus.emit("ContractUpgraded", CONTRACT, deployHash(), { name, from_version: from, to_version: c.version, wasm_hash });
    return rec;
  }

  current_version(name: string): number {
    return this.contracts.get(name)?.version ?? 0;
  }

  list(): ContractRecord[] {
    return [...this.contracts.values()].map((c) => ({ ...c }));
  }

  upgradeHistory(): UpgradeRecord[] {
    return [...this.history];
  }
}
