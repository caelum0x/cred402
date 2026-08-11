import type { Ledger } from "../ledger/ledger.js";
import { FXRP, fxrpToXrp, type FtsoPriceClient } from "../../packages/chain-adapters/src/index.js";
import type { FlareSatelliteVault } from "../../packages/chain-adapters/src/index.js";

/**
 * FTSO position-health engine — the risk brain behind the autonomous credit keeper.
 *
 * An agent's Flare credit line is drawn in FXRP but its creditworthiness cap is
 * denominated in USD. FXRP is volatile, so the USD value of an outstanding FXRP debt
 * moves with the live FTSO XRP/USD price: if XRP appreciates, the debt is worth more
 * dollars and eats further into the agent's cap. This engine turns that price risk
 * into a single, monitorable health factor and the exact deleverage needed to cure a
 * margin call — priced entirely off Flare's FTSO oracle, no third-party price API.
 *
 *   health_factor = usd_cap / current_debt_usd        (>1 = within cap)
 *   current_debt_usd = fxrp_debt × FTSO(XRP/USD)       (marked to the live oracle)
 */

export type PositionStatus = "healthy" | "watch" | "margin_call" | "liquidation" | "no_debt";

export interface PositionThresholds {
  /** HF below this but above marginCall → surface a warning. Default 1.3. */
  watch: number;
  /** HF below this → the keeper must deleverage. Default 1.15. */
  marginCall: number;
  /** HF below this → the position is underwater. Default 1.0. */
  liquidation: number;
  /** Deleverage restores HF to this target. Default 1.5. */
  target: number;
}

export const DEFAULT_THRESHOLDS: PositionThresholds = { watch: 1.3, marginCall: 1.15, liquidation: 1.0, target: 1.5 };

export interface PositionHealth {
  agent_id: string;
  asset: "FXRP";
  fxrp_debt: string; // smallest units (6 dp)
  fxrp_debt_whole: number;
  xrp_usd: number;
  price_source: string;
  /** True when the FXRP price is a stale live fallback (oracle outage) — the debt mark is unreliable. */
  price_stale: boolean;
  /** Current USD value of the FXRP debt, marked to the live FTSO price. */
  debt_usd: number;
  /** USD recorded on the Casper root at draw time (global exposure outstanding). */
  recorded_usd: number;
  /** debt_usd − recorded_usd: the price-risk drift since the draw. */
  price_drift_usd: number;
  /** The agent's USD creditworthiness cap (global exposure max_allowed). */
  cap_usd: number;
  /** LTV-weighted USD borrowing power from posted FTSO-priced collateral (0 if none). */
  collateral_usd: number;
  /** Total USD an agent can borrow against: cap_usd + collateral_usd. */
  borrowing_power_usd: number;
  utilization: number; // debt_usd / borrowing_power_usd
  health_factor: number; // borrowing_power_usd / debt_usd (Infinity when no debt)
  status: PositionStatus;
  /** FXRP to repay to restore the target health factor (0 when healthy). */
  deleverage_fxrp: number;
  thresholds: PositionThresholds;
}

export class PositionEngine {
  private readonly thresholds: PositionThresholds;

  constructor(
    private readonly vault: FlareSatelliteVault,
    private readonly ledger: Ledger,
    private readonly ftso: FtsoPriceClient,
    thresholds: Partial<PositionThresholds> = {},
    private readonly collateral?: { borrowingPowerUsd(agentId: string): Promise<number> },
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Assess one agent's FXRP position against the live FTSO price. Pass
   * `priceOverride` to stress-test the position at a hypothetical XRP/USD price
   * ("what if XRP doubles?") without waiting for the market to move.
   */
  async assess(agentId: string, opts: { priceOverride?: number } = {}): Promise<PositionHealth> {
    const fxrpDebt = this.vault.debtOf(agentId); // FXRP smallest units
    const feed = await this.ftso.getPrice(FXRP.ftso_feed);
    // Only honor a positive, finite what-if price; a 0/empty/negative override must
    // NOT mark the debt at $0 (which would falsely read as a healthy position).
    const override = opts.priceOverride;
    const useOverride = typeof override === "number" && Number.isFinite(override) && override > 0;
    const price = useOverride
      ? { value: override, source: "what-if", stale: false }
      : { value: feed.value, source: feed.source, stale: feed.stale };
    const exposure = this.ledger.exposure.get_agent_global_exposure(agentId);

    const debtWhole = fxrpToXrp(fxrpDebt);
    const debtUsd = debtWhole * price.value;
    const capUsd = exposure ? Number(exposure.max_allowed) / 1e6 : 0;
    const recordedUsd = exposure ? Number(exposure.outstanding) / 1e6 : 0;
    // Posted collateral, FTSO-priced + LTV-haircut, expands borrowing power beyond the
    // reputation cap. No collateral (or no vault) → 0, so behavior is unchanged.
    const collateralUsd = this.collateral ? await this.collateral.borrowingPowerUsd(agentId) : 0;
    const borrowingPowerUsd = capUsd + collateralUsd;

    const healthFactor = debtUsd > 0 ? borrowingPowerUsd / debtUsd : Infinity;
    const status = this.classify(fxrpDebt, healthFactor);
    const deleverageFxrp = this.requiredDeleverage(debtUsd, borrowingPowerUsd, price.value, status);

    return {
      agent_id: agentId,
      asset: "FXRP",
      fxrp_debt: fxrpDebt.toString(),
      fxrp_debt_whole: debtWhole,
      xrp_usd: price.value,
      price_source: price.source,
      price_stale: price.stale,
      debt_usd: round2(debtUsd),
      recorded_usd: round2(recordedUsd),
      price_drift_usd: round2(debtUsd - recordedUsd),
      cap_usd: round2(capUsd),
      collateral_usd: round2(collateralUsd),
      borrowing_power_usd: round2(borrowingPowerUsd),
      utilization: borrowingPowerUsd > 0 ? round4(debtUsd / borrowingPowerUsd) : 0,
      health_factor: healthFactor === Infinity ? Infinity : round4(healthFactor),
      status,
      deleverage_fxrp: round2(deleverageFxrp),
      thresholds: this.thresholds,
    };
  }

  /**
   * FXRP to repay to reach a specific target health factor — the proactive form of
   * requiredDeleverage (which only fires on a margin call). Used by automations that
   * deleverage a position BEFORE it breaches, e.g. on an FTSO price trigger. Returns
   * 0 (a no-op) when the position is already at or above the target.
   */
  async deleverageToTarget(agentId: string, targetHf: number, opts: { priceOverride?: number } = {}): Promise<{ position: PositionHealth; deleverage_fxrp: number }> {
    const position = await this.assess(agentId, opts);
    if (position.debt_usd <= 0 || position.xrp_usd <= 0 || position.borrowing_power_usd <= 0 || targetHf <= 0) {
      return { position, deleverage_fxrp: 0 };
    }
    const targetDebtUsd = position.borrowing_power_usd / targetHf;
    const repayUsd = Math.max(0, position.debt_usd - targetDebtUsd);
    const repayFxrp = Math.min(repayUsd / position.xrp_usd, position.fxrp_debt_whole);
    return { position, deleverage_fxrp: round2(repayFxrp) };
  }

  private classify(fxrpDebt: bigint, hf: number): PositionStatus {
    if (fxrpDebt === 0n) return "no_debt";
    if (hf < this.thresholds.liquidation) return "liquidation";
    if (hf < this.thresholds.marginCall) return "margin_call";
    if (hf < this.thresholds.watch) return "watch";
    return "healthy";
  }

  /**
   * FXRP to repay to bring the position back to the target HF. Only triggers on a
   * margin call or worse; clamps to the current debt.
   */
  private requiredDeleverage(debtUsd: number, borrowingPowerUsd: number, price: number, status: PositionStatus): number {
    if (status !== "margin_call" && status !== "liquidation") return 0;
    if (price <= 0 || borrowingPowerUsd <= 0) return 0;
    const targetDebtUsd = borrowingPowerUsd / this.thresholds.target;
    const repayUsd = Math.max(0, debtUsd - targetDebtUsd);
    const repayFxrp = repayUsd / price;
    const debtFxrp = debtUsd / price;
    return Math.min(repayFxrp, debtFxrp);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
