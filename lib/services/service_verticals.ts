import { categoryFamily, categoryRiskBps, CATEGORY_RISK_BPS } from "../core/service_categories.js";

/**
 * Service verticals (roadmap p10).
 *
 * p1 made every x402 service a credit input via category risk *weights*. p10 makes
 * each major family a first-class *credit vertical* with its own underwriting
 * profile: how much of projected revenue can be advanced, the expected revenue
 * volatility (which haircuts the advance), the settlement horizon, the minimum
 * track record, and the attestations required to qualify. This is what lets
 * Cred402 open distinct credit products for compute, inference, and data markets —
 * each underwritten on its own economics — rather than one-size-fits-all.
 */

export type RiskBand = "low" | "moderate" | "elevated" | "high";

export interface VerticalProfile {
  vertical: string; // family key (rwa, compute, inference, data, …)
  display_name: string;
  /** Fraction of projected revenue advanceable as credit, in bps. */
  advance_rate_bps: number;
  /** Expected revenue volatility, in bps; haircuts the advance. */
  revenue_volatility_bps: number;
  /** Typical receipt finalization horizon, in days. */
  settlement_days: number;
  /** Minimum finalized jobs before the vertical will underwrite. */
  min_track_record_jobs: number;
  /** Attestations a borrower must hold to qualify in this vertical. */
  required_attestations: string[];
  risk_band: RiskBand;
}

function bandFor(riskBps: number): RiskBand {
  if (riskBps >= 9500) return "low";
  if (riskBps >= 9000) return "moderate";
  if (riskBps >= 8000) return "elevated";
  return "high";
}

/** Seed underwriting profiles for the launch verticals (tunable by governance). */
export const SEED_VERTICAL_PROFILES: readonly VerticalProfile[] = [
  { vertical: "rwa", display_name: "RWA verification", advance_rate_bps: 7000, revenue_volatility_bps: 800, settlement_days: 14, min_track_record_jobs: 10, required_attestations: ["evidence_corroboration"], risk_band: bandFor(CATEGORY_RISK_BPS.rwa!) },
  { vertical: "compliance", display_name: "Compliance attestations", advance_rate_bps: 6500, revenue_volatility_bps: 600, settlement_days: 7, min_track_record_jobs: 8, required_attestations: ["regulator_registration"], risk_band: bandFor(CATEGORY_RISK_BPS.compliance!) },
  { vertical: "data", display_name: "Data markets", advance_rate_bps: 6000, revenue_volatility_bps: 1500, settlement_days: 3, min_track_record_jobs: 20, required_attestations: ["data_provenance"], risk_band: bandFor(CATEGORY_RISK_BPS.data!) },
  { vertical: "api", display_name: "API services", advance_rate_bps: 6000, revenue_volatility_bps: 1200, settlement_days: 3, min_track_record_jobs: 20, required_attestations: [], risk_band: bandFor(CATEGORY_RISK_BPS.api!) },
  { vertical: "compute", display_name: "Compute markets", advance_rate_bps: 5500, revenue_volatility_bps: 2000, settlement_days: 2, min_track_record_jobs: 25, required_attestations: ["proof_of_compute"], risk_band: bandFor(CATEGORY_RISK_BPS.compute!) },
  { vertical: "storage", display_name: "Storage markets", advance_rate_bps: 5500, revenue_volatility_bps: 1000, settlement_days: 5, min_track_record_jobs: 15, required_attestations: ["proof_of_storage"], risk_band: bandFor(CATEGORY_RISK_BPS.storage!) },
  { vertical: "inference", display_name: "Inference markets", advance_rate_bps: 5000, revenue_volatility_bps: 2500, settlement_days: 2, min_track_record_jobs: 30, required_attestations: ["output_quality_audit"], risk_band: bandFor(CATEGORY_RISK_BPS.inference!) },
  { vertical: "dispute", display_name: "Dispute / arbitration", advance_rate_bps: 5000, revenue_volatility_bps: 1800, settlement_days: 10, min_track_record_jobs: 15, required_attestations: [], risk_band: bandFor(CATEGORY_RISK_BPS.dispute!) },
  { vertical: "defi", display_name: "DeFi services", advance_rate_bps: 4000, revenue_volatility_bps: 3500, settlement_days: 1, min_track_record_jobs: 40, required_attestations: ["market_risk_disclosure"], risk_band: bandFor(CATEGORY_RISK_BPS.defi!) },
];

export interface QualifyInput {
  track_record_jobs: number;
  attestations: string[];
}

export interface QualifyResult {
  eligible: boolean;
  vertical: string;
  missing_attestations: string[];
  track_record_shortfall: number; // 0 if met
}

export interface AdvanceSizing {
  vertical: string;
  projected_revenue_motes: string;
  advance_rate_bps: number;
  volatility_haircut_bps: number;
  /** Final advanceable credit after rate × (1 − haircut). */
  advance_motes: string;
}

export class ServiceVerticals {
  private readonly profiles = new Map<string, VerticalProfile>();

  constructor(seed: readonly VerticalProfile[] = SEED_VERTICAL_PROFILES) {
    for (const p of seed) this.profiles.set(p.vertical, clone(p));
  }

  /** Resolve the profile governing a service type (by its family). */
  profileFor(serviceType: string): VerticalProfile | undefined {
    const p = this.profiles.get(categoryFamily(serviceType));
    return p ? clone(p) : undefined;
  }

  get(vertical: string): VerticalProfile | undefined {
    const p = this.profiles.get(vertical);
    return p ? clone(p) : undefined;
  }

  isSupported(serviceType: string): boolean {
    return this.profiles.has(categoryFamily(serviceType));
  }

  /** Register or replace a vertical profile (governance-tunable). */
  register(profile: VerticalProfile): VerticalProfile {
    if (profile.advance_rate_bps < 0 || profile.advance_rate_bps > 10000) throw new Error("advance_rate_bps out of range");
    if (profile.revenue_volatility_bps < 0 || profile.revenue_volatility_bps > 10000) throw new Error("revenue_volatility_bps out of range");
    this.profiles.set(profile.vertical, clone(profile));
    return clone(profile);
  }

  list(): VerticalProfile[] {
    return [...this.profiles.values()].map(clone).sort((a, b) => b.advance_rate_bps - a.advance_rate_bps);
  }

  /** Check whether a borrower qualifies for credit in a service type's vertical. */
  qualify(serviceType: string, input: QualifyInput): QualifyResult {
    const p = this.profileFor(serviceType);
    const vertical = p?.vertical ?? categoryFamily(serviceType);
    if (!p) {
      return { eligible: false, vertical, missing_attestations: [], track_record_shortfall: 0 };
    }
    const held = new Set(input.attestations);
    const missing = p.required_attestations.filter((a) => !held.has(a));
    const shortfall = Math.max(0, p.min_track_record_jobs - input.track_record_jobs);
    return {
      eligible: missing.length === 0 && shortfall === 0,
      vertical,
      missing_attestations: missing,
      track_record_shortfall: shortfall,
    };
  }

  /**
   * Size an advance for a service type's vertical: a fraction of projected
   * revenue (advance_rate) haircut by the vertical's revenue volatility. Returns 0
   * for an unsupported vertical.
   */
  sizeAdvance(serviceType: string, projectedRevenueMotes: bigint): AdvanceSizing {
    const p = this.profileFor(serviceType);
    const vertical = p?.vertical ?? categoryFamily(serviceType);
    if (!p || projectedRevenueMotes <= 0n) {
      return {
        vertical,
        projected_revenue_motes: (projectedRevenueMotes > 0n ? projectedRevenueMotes : 0n).toString(),
        advance_rate_bps: p?.advance_rate_bps ?? 0,
        volatility_haircut_bps: p?.revenue_volatility_bps ?? 0,
        advance_motes: "0",
      };
    }
    const gross = (projectedRevenueMotes * BigInt(p.advance_rate_bps)) / 10000n;
    const advance = (gross * BigInt(10000 - p.revenue_volatility_bps)) / 10000n;
    return {
      vertical,
      projected_revenue_motes: projectedRevenueMotes.toString(),
      advance_rate_bps: p.advance_rate_bps,
      volatility_haircut_bps: p.revenue_volatility_bps,
      advance_motes: advance.toString(),
    };
  }

  /** Sanity check: every seeded vertical maps to a known category family. */
  static coversCategoryFamilies(verticals = SEED_VERTICAL_PROFILES): boolean {
    return Object.keys(CATEGORY_RISK_BPS).every((fam) => verticals.some((v) => v.vertical === fam));
  }
}

function clone(p: VerticalProfile): VerticalProfile {
  return { ...p, required_attestations: [...p.required_attestations] };
}

// Re-export for callers wiring vertical-aware underwriting.
export { categoryRiskBps };
