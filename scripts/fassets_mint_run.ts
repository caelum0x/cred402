/**
 * fassets_mint_run.ts — the FAssets mint → collateralize loop end to end.
 *
 * An agent brings real XRP (a non-smart-contract asset): it reserves minting on the
 * FXRP AssetManager, the FDC attests the XRPL payment, and FXRP is minted 1:1. The
 * minted FXRP is then posted as FTSO-priced collateral, expanding the agent's
 * borrowing power with no repay — XRP becomes usable agent working capital on Flare.
 *
 *   npm run fassets:mint
 *
 * Sim by default; set FLARE_FDC_VERIFIER_URL for a real FDC Payment attestation and
 * FLARE_RPC_URL for live FTSO collateral pricing.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { PositionEngine } from "../lib/flare/positions.js";
import { FAssetsMinter } from "../lib/flare/fassets_mint.js";
import { fxrpToXrp } from "../packages/chain-adapters/src/index.js";
import { banner, scene } from "./render.js";

async function main(): Promise<void> {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.applyReputationEngine();
  econ.scoreJob();
  econ.underwriteSeller();
  const agentId = econ.seller.agent_id;

  const flare = new FlareCreditSatellite(ledger);
  const engine = new PositionEngine(flare.vault, ledger, flare.priceClient, {}, flare.collateral);
  const minter = new FAssetsMinter();

  banner("Cred402 FAssets — mint FXRP from attested XRP → collateralize");

  // 1) Reserve minting for 5,000 XRP.
  const reservation = minter.reserveMinting(agentId, 5000n * 1_000_000n);
  scene({
    scene: "Reserve minting on the FXRP AssetManager",
    lines: [
      `reservation ${reservation.reservation_id} · pay ${fxrpToXrp(BigInt(reservation.underlying_drops))} XRP → ${reservation.payment_address}`,
      `reservation fee ${fxrpToXrp(BigInt(reservation.reservation_fee_drops))} XRP · will mint ${fxrpToXrp(BigInt(reservation.fxrp_amount))} FXRP`,
    ],
  });

  // 2) Agent pays XRP on the XRPL; the FDC attests it and minting executes.
  const mint = await minter.executeMinting(reservation.reservation_id, "XRPL-tx-abc123");
  scene({
    scene: "FDC attests the XRPL payment → executeMinting",
    lines: [
      `minted ${fxrpToXrp(BigInt(mint.fxrp_minted))} FXRP (balance ${fxrpToXrp(BigInt(mint.fxrp_balance))})`,
      `FDC attestation ${mint.fdc_attestation_id.slice(0, 18)}… · verified ${mint.fdc_verified} · source ${mint.fdc_source}`,
    ],
  });

  // 3) Post the minted FXRP as collateral (FXRP is XRP 1:1 on the XRP/USD feed).
  const before = await engine.assess(agentId);
  flare.collateral.deposit(agentId, "XRP", fxrpToXrp(BigInt(mint.fxrp_minted)));
  const val = await flare.collateral.valueUsd(agentId);
  const after = await engine.assess(agentId);
  scene({
    scene: "Post minted FXRP as FTSO-priced collateral",
    lines: [
      `collateral value $${val.total_value_usd} → borrowing power +$${val.borrowing_power_usd}`,
      `borrowing power ${before.borrowing_power_usd} → ${after.borrowing_power_usd} USD (no repay, no new debt)`,
    ],
  });

  // 4) Redeem part of the FXRP back to XRP.
  const redeem = minter.redeem(agentId, 1000n * 1_000_000n);
  scene({
    scene: "Redeem 1,000 FXRP → XRP",
    lines: [`burned ${fxrpToXrp(BigInt(redeem.fxrp_burned))} FXRP · XRPL redemption ${redeem.xrpl_redemption_ticket.slice(0, 18)}…`, `FXRP balance now ${fxrpToXrp(BigInt(redeem.fxrp_balance))}`],
  });

  scene({ scene: "FAssets supply", lines: [`circulating FXRP: ${fxrpToXrp(minter.totalSupply())}`] });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
