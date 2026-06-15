import { applyBps, cspr, MOTES_PER_CSPR } from "./units.js";

/**
 * Protocol economics & fee model (p4 §11).
 *
 * Centralizes every Cred402 revenue stream and the honest LP-yield accounting.
 * All rates are basis points (10000 = 100%); all values are integer motes, so
 * the numbers here match exactly what the on-chain contracts would charge.
 *
 *   registration fee        small fixed CSPR fee per agent
 *   receipt recording fee   tiny fixed CSPR fee per x402 receipt
 *   facilitator fee         0.20%–0.50% of each x402 payment
 *   credit origination fee  0.50% of an opened credit line
 *   interest spread         10% of agent interest routed to the protocol
 *   slashing route          50% victim / 25% insurance / 25% treasury
 */

export interface FeeSchedule {
  registration_fee: bigint; // motes
  receipt_recording_fee: bigint; // motes
  facilitator_fee_bps: bigint;
  origination_fee_bps: bigint;
  interest_spread_bps: bigint; // protocol's share of interest
  late_fee_bps: bigint; // per overdue period, on outstanding principal
}

export interface SlashRoute {
  victim_bps: bigint;
  insurance_bps: bigint;
  treasury_bps: bigint;
  burn_bps: bigint;
}

/** p4 §11.2 launch parameters. */
export const DEFAULT_FEE_SCHEDULE: FeeSchedule = {
  registration_fee: cspr("0.1"),
  receipt_recording_fee: cspr("0.0001"),
  facilitator_fee_bps: 30n, // 0.30%
  origination_fee_bps: 50n, // 0.50%
  interest_spread_bps: 1000n, // 10% of interest to protocol
  late_fee_bps: 200n, // 2% per overdue period
};

/** p4 §11.2 slashing route: 50% victim, 25% insurance, 25% treasury. */
export const DEFAULT_SLASH_ROUTE: SlashRoute = {
  victim_bps: 5000n,
  insurance_bps: 2500n,
  treasury_bps: 2500n,
  burn_bps: 0n,
};

export interface SlashSplit {
  to_victim: bigint;
  to_insurance: bigint;
  to_treasury: bigint;
  to_burn: bigint;
}

export interface PoolSnapshot {
  total_liquidity: bigint;
  outstanding_credit: bigint;
  interest_accrued: bigint; // realized interest paid to the pool
  fees_collected: bigint; // realized origination/late fees to the pool
  default_losses: bigint; // realized principal lost to defaults
  elapsed_seconds: number; // age of the pool / measurement window
}

export interface PoolHealth {
  utilization: number; // 0..1 outstanding / liquidity
  realized_yield: bigint; // interest + fees − losses (motes)
  realized_apy: number; // annualized on average deployed liquidity, 0..1+
  loss_rate: number; // losses / liquidity
  /** Honest risk disclosures — "no fake APY" (p4 §11.3). */
  risk_flags: string[];
}

const YEAR_SECONDS = 365 * 24 * 60 * 60;

export class ProtocolEconomics {
  constructor(private readonly schedule: FeeSchedule = DEFAULT_FEE_SCHEDULE) {}

  get fees(): FeeSchedule {
    return this.schedule;
  }

  /** Facilitator fee skimmed from an x402 payment. */
  facilitatorFee(amount: bigint): bigint {
    return applyBps(amount, this.schedule.facilitator_fee_bps);
  }

  /** Origination fee charged when a credit line is opened. */
  originationFee(principal: bigint): bigint {
    return applyBps(principal, this.schedule.origination_fee_bps);
  }

  /** Late fee on overdue principal for `periods` overdue intervals. */
  lateFee(outstanding: bigint, periods: number): bigint {
    if (periods <= 0) return 0n;
    return applyBps(outstanding, this.schedule.late_fee_bps) * BigInt(periods);
  }

  /** Protocol's cut of paid interest; the remainder accrues to LPs. */
  protocolInterestShare(interest: bigint): bigint {
    return applyBps(interest, this.schedule.interest_spread_bps);
  }

  lpInterestShare(interest: bigint): bigint {
    return interest - this.protocolInterestShare(interest);
  }

  /** Split a slashed amount across destinations (p4 §11.2). Treasury absorbs dust. */
  slashSplit(amount: bigint, route: SlashRoute = DEFAULT_SLASH_ROUTE): SlashSplit {
    if (route.victim_bps + route.insurance_bps + route.treasury_bps + route.burn_bps !== 10000n) {
      throw new Error("slash route must sum to 10000 bps");
    }
    const to_victim = applyBps(amount, route.victim_bps);
    const to_insurance = applyBps(amount, route.insurance_bps);
    const to_burn = applyBps(amount, route.burn_bps);
    const to_treasury = amount - to_victim - to_insurance - to_burn; // dust → treasury
    return { to_victim, to_insurance, to_treasury, to_burn };
  }

  /**
   * Honest LP yield (p4 §11.3): realized APY from interest + fees − losses,
   * annualized on average deployed liquidity, plus risk disclosures. Never an
   * advertised/projected rate — only what the pool actually earned.
   */
  poolHealth(s: PoolSnapshot): PoolHealth {
    const utilization = s.total_liquidity > 0n ? Number(s.outstanding_credit) / Number(s.total_liquidity) : 0;
    const realized_yield = s.interest_accrued + s.fees_collected - s.default_losses;
    const loss_rate = s.total_liquidity > 0n ? Number(s.default_losses) / Number(s.total_liquidity) : 0;

    // APY on the capital actually at work (utilization-weighted liquidity).
    const deployed = Number(s.total_liquidity) * Math.max(utilization, 0.0001);
    const years = Math.max(s.elapsed_seconds, 1) / YEAR_SECONDS;
    const realized_apy = deployed > 0 ? (Number(realized_yield) / deployed) / years : 0;

    const risk_flags: string[] = [];
    if (s.default_losses > 0n) risk_flags.push(`realized default losses ${motesCspr(s.default_losses)} CSPR`);
    if (utilization > 0.9) risk_flags.push(`high utilization ${(utilization * 100).toFixed(0)}% — liquidity-run risk`);
    if (utilization < 0.05) risk_flags.push(`idle pool ${(utilization * 100).toFixed(0)}% — yield is near zero`);
    if (realized_yield < 0n) risk_flags.push(`net loss this window — APY is negative`);

    return { utilization, realized_yield, realized_apy, loss_rate, risk_flags };
  }
}

function motesCspr(motes: bigint): string {
  return (Number(motes) / Number(MOTES_PER_CSPR)).toFixed(2);
}
