import type { Ledger } from "../ledger/ledger.js";
import { DEFAULT_FEE_SCHEDULE } from "../core/economics.js";
import { TIER_ORDER, TIER_THRESHOLDS, TIER_PERKS } from "./reputation_tiers.js";

/**
 * Protocol config — the rulebook, self-documenting. Integrators (and agents)
 * shouldn't have to read the source to know the fee schedule, the credit gates, or
 * how reputation tiers translate to perks. This exposes the current, live protocol
 * parameters in one read so callers can reason about costs and eligibility up front.
 */

export interface ProtocolConfig {
  policy_version: string;
  fees: {
    facilitator_fee_bps: number;
    origination_fee_bps: number;
    interest_spread_bps: number;
    late_fee_bps: number;
  };
  governance: {
    origination_fee_bps: number;
    min_reputation_to_draw: number;
    max_agent_exposure_motes: string;
  };
  reputation_tiers: { tier: string; min_reputation: number; credit_multiplier: number; origination_discount_bps: number }[];
  units: { motes_per_cspr: number };
}

export function buildProtocolConfig(ledger: Ledger): ProtocolConfig {
  const gov = ledger.governance.get();
  return {
    policy_version: ledger.policy.version(),
    fees: {
      facilitator_fee_bps: Number(DEFAULT_FEE_SCHEDULE.facilitator_fee_bps),
      origination_fee_bps: Number(DEFAULT_FEE_SCHEDULE.origination_fee_bps),
      interest_spread_bps: Number(DEFAULT_FEE_SCHEDULE.interest_spread_bps),
      late_fee_bps: Number(DEFAULT_FEE_SCHEDULE.late_fee_bps),
    },
    governance: {
      origination_fee_bps: gov.origination_fee_bps,
      min_reputation_to_draw: gov.min_reputation_to_draw,
      max_agent_exposure_motes: gov.max_agent_exposure.toString(),
    },
    reputation_tiers: TIER_ORDER.map((tier) => ({
      tier,
      min_reputation: TIER_THRESHOLDS[tier],
      credit_multiplier: TIER_PERKS[tier].mult,
      origination_discount_bps: TIER_PERKS[tier].discount,
    })),
    units: { motes_per_cspr: 1_000_000_000 },
  };
}
