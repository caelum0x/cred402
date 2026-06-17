/**
 * Service category taxonomy + risk weights (roadmap p1).
 *
 * Cred402 is the credit layer for the WHOLE x402 economy, not just RWA. Every
 * x402-payable service belongs to a category; each category carries a credit-risk
 * weight that scales how much of its cash flow underwrites credit. RWA verification
 * is one family among many — `data.*`, `compute.*`, `inference.*`, `storage.*`,
 * `api.*`, `defi.*`, `compliance.*`, `dispute.*`.
 *
 * This is the canonical (dependency-free) source of truth. The on-chain
 * `ServiceCategoryRegistry` (lib/ledger/contracts/service_category_registry.ts)
 * mirrors it and lets governance add categories / tune weights without a redeploy.
 */

/** Credit-risk weight per category family, in basis points (10000 = 1.0×). */
export const CATEGORY_RISK_BPS: Record<string, number> = {
  // RWA verification — evidence-corroborated, the proven wedge.
  rwa: 10000,
  // Compliance attestations — verifiable, low variance.
  compliance: 9500,
  // Data + API usage — metered, verifiable usage.
  data: 9000,
  api: 9000,
  // Compute + storage — fungible, recurring, verifiable.
  compute: 8500,
  storage: 8500,
  // Inference — valuable but output quality varies.
  inference: 8000,
  // Dispute/arbitration services.
  dispute: 8000,
  // DeFi services — carry market risk.
  defi: 7500,
};

/** Conservative default for any unregistered family. */
export const DEFAULT_CATEGORY_RISK_BPS = 6500;

/** Seed categories (family + concrete service types) shipped by default. */
export const SEED_SERVICE_CATEGORIES: readonly string[] = [
  // RWA
  "rwa.energy_output", "rwa.weather_risk", "rwa.receivable_quality", "rwa.invoice_validity",
  "rwa.shipping_status", "rwa.insurance_check", "rwa.carbon_credit_verification", "rwa.payment_monitoring",
  // Universal x402 services
  "data.market", "data.feed", "api.generic", "api.identity",
  "compute.gpu", "compute.batch", "storage.object",
  "inference.llm", "inference.vision", "inference.embedding",
  "defi.yield_routing", "defi.liquidity_monitoring",
  "compliance.kyb_check", "compliance.sanctions_screening",
  "dispute.evidence_review",
] as const;

/** Legacy (pre-p1) flat service types → their family, for back-compat. */
const LEGACY_FAMILY: Record<string, string> = {
  solar_output_verification: "rwa",
  weather_risk: "rwa",
  receivable_quality: "rwa",
  risk_scoring: "rwa",
  monitoring: "rwa",
  treasury_routing: "defi",
};

/** The family prefix of a service type, e.g. "inference.llm" -> "inference". */
export function categoryFamily(serviceType: string): string {
  const dot = serviceType.indexOf(".");
  if (dot !== -1) return serviceType.slice(0, dot);
  return LEGACY_FAMILY[serviceType] ?? serviceType;
}

/** Risk weight (bps) for a service type, by its family (or the default). */
export function categoryRiskBps(serviceType: string): number {
  return CATEGORY_RISK_BPS[categoryFamily(serviceType)] ?? DEFAULT_CATEGORY_RISK_BPS;
}

/** Credit-risk multiplier in (0, 1] applied to an agent's credit line. */
export function categoryRiskMultiplier(serviceType: string): number {
  return categoryRiskBps(serviceType) / 10000;
}
