export type ServiceType =
  | "solar_output_verification"
  | "weather_risk"
  | "receivable_quality"
  | "risk_scoring"
  | "treasury_routing"
  | "monitoring";

export type Scope = "read" | "write" | "admin";

export interface Agent {
  agent_id: string;
  service_type: ServiceType;
  reputation_score: number;
  credit_score: number;
  dispute_rate: number;
  total_jobs_completed: number;
  stake: string;
  active: boolean;
}

export interface ReasonCode {
  code: string;
  polarity: "positive" | "negative";
  detail: string;
}

export interface CreditDecision {
  policy_version: string;
  credit_line: string;
  credit_score: number;
  interest_rate_bps: number;
  reason_codes?: ReasonCode[];
}

export interface CreditExplain {
  decision: CreditDecision;
  fraud_score: number;
  realfi_multiplier: number;
  eligible: boolean;
  ineligible_reason?: string;
}

export interface CreditLine {
  agent_id: string;
  max_credit: string;
  drawn: string;
  interest_rate_bps: number;
  status: string;
}

export interface MarketListing {
  listing_id: string;
  agent_id: string;
  category: string;
  strategy: string;
  base_price: string;
  reputation_score: number;
  receipt_count: number;
  supported_chains: string[];
}

export interface IssuedApiKey {
  id: string;
  secret: string;
  scopes: Scope[];
}

export interface WebhookSubscription {
  id: string;
  url: string;
  events: string[];
  secret: string;
}

/** 1 CSPR = 1e9 motes. */
export function motesToCspr(motes: string): number {
  return Number(motes) / 1_000_000_000;
}

export function csprToMotes(cspr: number): bigint {
  return BigInt(Math.round(cspr * 1_000_000_000));
}
