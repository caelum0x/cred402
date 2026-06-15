import type { ServiceType } from "../../lib/core/types.js";
import { SOLAR_FARM_A17, fetchSolarReadings, type SolarReadings } from "./solar_provider.js";

/**
 * Real RWA data access layer.
 *
 * Evidence is derived from live solar/weather data (Open-Meteo) via a real PV
 * model — see `solar_provider.ts`. Readings are cached per asset for the life of
 * the process so the three evidence types for one job stay mutually consistent.
 */

export interface EvidencePayload {
  evidence_type: string;
  service_type: ServiceType;
  fields: Record<string, unknown>;
  confidence: number;
  source: string;
  tampered?: boolean;
}

/** RWA job metadata used by the BuyerAgent / economy. */
export const SOLAR_A17 = {
  rwa_id: SOLAR_FARM_A17.rwa_id,
  name: SOLAR_FARM_A17.name,
  location: SOLAR_FARM_A17.location,
  monthly_output_kwh: SOLAR_FARM_A17.expected_monthly_kwh,
  expected_receivable_usd: SOLAR_FARM_A17.expected_receivable_usd,
  collateral_type: SOLAR_FARM_A17.collateral_type,
  needed_evidence: ["energy_output", "weather_risk", "receivable_quality"],
} as const;

export const KNOWN_EVIDENCE_TYPES = SOLAR_A17.needed_evidence;

export const SERVICE_TYPE_BY_EVIDENCE: Record<string, ServiceType> = {
  energy_output: "solar_output_verification",
  weather_risk: "weather_risk",
  receivable_quality: "receivable_quality",
};

export function serviceTypeFor(evidence_type: string): ServiceType {
  const s = SERVICE_TYPE_BY_EVIDENCE[evidence_type];
  if (!s) throw new Error(`unknown evidence type: ${evidence_type}`);
  return s;
}

const cache = new Map<string, SolarReadings>();

async function readings(rwa_id = SOLAR_FARM_A17.rwa_id): Promise<SolarReadings> {
  const cached = cache.get(rwa_id);
  if (cached) return cached;
  const r = await fetchSolarReadings(SOLAR_FARM_A17);
  cache.set(rwa_id, r);
  return r;
}

/** Clear cached readings (used between demo runs / tests). */
export function clearReadingsCache(): void {
  cache.clear();
}

export function isKnownEvidenceType(t: string): boolean {
  return (KNOWN_EVIDENCE_TYPES as readonly string[]).includes(t);
}

/** Produce a real evidence payload for the given evidence type. */
export async function fetchEvidence(evidence_type: string, opts: { tampered?: boolean } = {}): Promise<EvidencePayload> {
  const r = await readings();
  switch (evidence_type) {
    case "energy_output":
      return {
        evidence_type,
        service_type: "solar_output_verification",
        confidence: r.source === "open-meteo" ? 92 : 84,
        source: r.source,
        tampered: opts.tampered,
        fields: {
          // A dishonest seller inflates the reading far beyond what irradiance allows.
          measured_kwh: opts.tampered ? Math.round(r.measured_kwh * 1.65 + 40_000) : r.measured_kwh,
          expected_kwh: SOLAR_FARM_A17.expected_monthly_kwh,
          ghi_kwh_m2_day: r.ghi_kwh_m2_day,
          meter_id: "EM-A17-001",
          deviation_pct:
            Math.round(
              (Math.abs((opts.tampered ? r.measured_kwh * 1.65 + 40_000 : r.measured_kwh) - SOLAR_FARM_A17.expected_monthly_kwh) /
                SOLAR_FARM_A17.expected_monthly_kwh) *
                1000,
            ) / 10,
        },
      };
    case "weather_risk":
      return {
        evidence_type,
        service_type: "weather_risk",
        confidence: 86,
        source: r.source,
        fields: {
          anomaly_risk: r.weather_anomaly_risk,
          cloudcover_mean_pct: r.cloudcover_mean,
          storm_days_16d: r.storm_days,
          irradiance_index: Math.round((r.ghi_kwh_m2_day / 8) * 100) / 100,
        },
      };
    case "receivable_quality":
      return {
        evidence_type,
        service_type: "receivable_quality",
        confidence: r.receivable_confidence,
        source: r.source,
        fields: {
          offtaker: SOLAR_FARM_A17.offtaker,
          payment_terms_days: SOLAR_FARM_A17.payment_terms_days,
          historical_default_rate: SOLAR_FARM_A17.historical_default_rate,
          receivable_confidence: r.receivable_confidence,
          recommended_max_ltv: r.recommended_max_ltv,
        },
      };
    default:
      throw new Error(`no data source for evidence type: ${evidence_type}`);
  }
}

/** An independent energy estimate the WatchdogAgent cross-checks against. */
export async function fetchIndependentEnergyReading(): Promise<number> {
  const r = await readings();
  return r.independent_kwh;
}
