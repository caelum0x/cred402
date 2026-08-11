import type { FtsoPriceClient } from "./ftso.js";

/**
 * FAssets — Flare's system for using non-smart-contract assets (starting with XRP)
 * as first-class ERC-20s on Flare. FXRP is XRP bridged 1:1 into an EVM asset,
 * minted against over-collateralized agents and redeemable back to the XRP Ledger.
 *
 * For Cred402, FXRP is the **interoperable settlement + collateral asset** of the
 * Flare satellite: an agent that earns x402 revenue on any chain can borrow working
 * capital in FXRP, priced in USD from the live FTSO XRP/USD feed. That is the
 * Interoperable-Asset-Products thesis made concrete — XRP liquidity, credit-gated
 * by Casper, priced by Flare.
 *
 * Docs: https://dev.flare.network/fassets/overview
 */

export interface FAssetDescriptor {
  symbol: "FXRP";
  underlying: "XRP";
  decimals: number; // FXRP mirrors XRP's 6 dp
  ftso_feed: string; // FTSO feed used to value it in USD
}

export const FXRP: FAssetDescriptor = {
  symbol: "FXRP",
  underlying: "XRP",
  decimals: 6,
  ftso_feed: "XRP/USD",
};

/**
 * A minted FXRP position: FXRP that exists on Flare backed by an attested XRP
 * deposit on the XRP Ledger. `fdc_attestation_id` links the mint to the FDC proof
 * that the underlying XRP payment really happened (see fdc.ts).
 */
export interface FxrpMint {
  asset: "FXRP";
  amount: string; // smallest units (6 dp)
  xrpl_tx_hash: string; // the underlying XRPL payment
  fdc_attestation_id?: string; // FDC proof id, when attested
  minted_at: number;
}

/** Convert an FXRP smallest-unit amount to a human XRP figure. */
export function fxrpToXrp(amountSmallest: bigint): number {
  return Number(amountSmallest) / 10 ** FXRP.decimals;
}

/**
 * Value an FXRP amount in USD (6-dp integer, i.e. USDC-style) using the live FTSO
 * XRP/USD feed. This is what the vault uses to charge global exposure in a single
 * USD denominator across every satellite.
 */
export async function fxrpValueUsd(
  amountSmallest: bigint,
  ftso: FtsoPriceClient,
): Promise<{ usd_6dp: bigint; xrp_usd: number; source: string }> {
  const price = await ftso.getPrice(FXRP.ftso_feed);
  const xrp = fxrpToXrp(amountSmallest);
  const usd = xrp * price.value;
  return { usd_6dp: BigInt(Math.round(usd * 1e6)), xrp_usd: price.value, source: price.source };
}
