import { deployHash } from "../../core/hash.js";
import { SEED_SERVICE_CATEGORIES, categoryRiskBps, categoryFamily } from "../../core/service_categories.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "ServiceCategoryRegistry";

export interface ServiceCategoryRecord {
  category: string; // "<family>.<name>", e.g. "inference.llm"
  family: string; // "inference"
  risk_bps: number; // credit-risk weight (10000 = 1.0x)
  enabled: boolean;
  created_at: number;
}

/**
 * ServiceCategoryRegistry (roadmap p1) — the on-chain catalog of x402 service
 * categories Cred402 will underwrite, with a governance-tunable credit-risk weight
 * per category. This is what makes Cred402 a credit layer for the WHOLE x402
 * economy: any registered category (data, compute, inference, storage, api, defi,
 * compliance, rwa, …) is a first-class credit input. Mirrors the canonical
 * defaults in `lib/core/service_categories.ts`; governance can add categories or
 * tune weights without redeploying the pool or registries.
 */
export class ServiceCategoryRegistry {
  private readonly categories = new Map<string, ServiceCategoryRecord>();

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {
    // Seed the default taxonomy.
    for (const c of SEED_SERVICE_CATEGORIES) this.seed(c);
  }

  private seed(category: string): void {
    this.categories.set(category, {
      category,
      family: categoryFamily(category),
      risk_bps: categoryRiskBps(category),
      enabled: true,
      created_at: this.clock.now(),
    });
  }

  /** Governance: register (or re-enable) a category with an optional risk weight. */
  register_category(category: string, risk_bps?: number): ServiceCategoryRecord {
    const rec: ServiceCategoryRecord = {
      category,
      family: categoryFamily(category),
      risk_bps: risk_bps ?? categoryRiskBps(category),
      enabled: true,
      created_at: this.clock.now(),
    };
    this.categories.set(category, rec);
    this.bus.emit("ServiceCategoryRegistered", CONTRACT, deployHash(), {
      category,
      family: rec.family,
      risk_bps: rec.risk_bps,
    });
    return { ...rec };
  }

  /** Governance: tune a category's credit-risk weight (bps). */
  set_risk_weight(category: string, risk_bps: number): void {
    const rec = this.categories.get(category);
    if (!rec) return;
    rec.risk_bps = risk_bps;
    this.bus.emit("ServiceCategoryRiskUpdated", CONTRACT, deployHash(), { category, risk_bps });
  }

  set_enabled(category: string, enabled: boolean): void {
    const rec = this.categories.get(category);
    if (rec) rec.enabled = enabled;
  }

  /** Risk weight (bps) for a service type — registered value or canonical default. */
  risk_bps(serviceType: string): number {
    return this.categories.get(serviceType)?.risk_bps ?? categoryRiskBps(serviceType);
  }

  is_registered(serviceType: string): boolean {
    return this.categories.has(serviceType);
  }

  get(category: string): ServiceCategoryRecord | undefined {
    const r = this.categories.get(category);
    return r ? { ...r } : undefined;
  }

  list(): ServiceCategoryRecord[] {
    return [...this.categories.values()].map((r) => ({ ...r }));
  }
}
