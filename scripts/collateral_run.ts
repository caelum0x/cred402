/**
 * collateral_run.ts — FTSO-priced multi-asset collateral end to end.
 *
 * An agent draws an FXRP position that trips a margin call against its reputation cap.
 * Instead of deleveraging, it POSTS collateral in several assets (USDC, BTC, ETH) —
 * each marked to its live FTSO feed and discounted by an LTV haircut — which expands
 * its borrowing power and cures the position with no repay. This is Flare's multi-feed
 * FTSO oracle turning agent credit into a real over-collateralized primitive.
 *
 *   npm run collateral:run
 *
 * Sim by default (deterministic FTSO reference prices); set FLARE_RPC_URL for live FTSO.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { PositionEngine } from "../lib/flare/positions.js";
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

  banner("Cred402 collateral — FTSO-priced borrowing power");

  // 1) Draw a position that exceeds the reputation cap → margin call.
  await flare.draw(agentId, 8500n * 1_000_000n);
  const p0 = await engine.assess(agentId);
  scene({
    scene: "Draw 8,500 FXRP — over the reputation cap",
    lines: [
      `debt $${p0.debt_usd} vs cap $${p0.cap_usd} (collateral $${p0.collateral_usd}) → borrowing power $${p0.borrowing_power_usd}`,
      `health factor ${fmtHf(p0.health_factor)} · status ${p0.status.toUpperCase()}`,
    ],
  });

  // 2) Post collateral in three assets — FTSO-priced, LTV-discounted.
  flare.collateral.deposit(agentId, "USDC", 1500);
  flare.collateral.deposit(agentId, "BTC", 0.03);
  flare.collateral.deposit(agentId, "ETH", 0.5);
  const val = await flare.collateral.valueUsd(agentId);
  scene({
    scene: "Post collateral (USDC + BTC + ETH), valued by FTSO",
    lines: [
      ...val.lines.map(
        (l) => `${l.amount_whole} ${l.symbol} @ $${l.price_usd} (${l.price_source}) = $${l.value_usd} → $${l.borrowing_power_usd} power (LTV ${l.ltv_bps / 100}%)`,
      ),
      `total collateral value $${val.total_value_usd} → borrowing power +$${val.borrowing_power_usd}`,
    ],
  });

  // 3) The position is cured by collateral — no repay.
  const p1 = await engine.assess(agentId);
  scene({
    scene: "Position after collateral",
    lines: [
      `borrowing power now $${p1.borrowing_power_usd} (cap $${p1.cap_usd} + collateral $${p1.collateral_usd})`,
      `health factor ${fmtHf(p0.health_factor)} → ${fmtHf(p1.health_factor)} · status ${p1.status.toUpperCase()} — cured with no repay`,
    ],
  });

  // 4) Stress test: what if BTC/ETH crash? (drop XRP too via price override for FXRP debt.)
  const stress = await engine.assess(agentId, { priceOverride: p1.xrp_usd * 1.5 });
  scene({
    scene: `Stress — XRP/USD +50% to $${round2(p1.xrp_usd * 1.5)}`,
    lines: [`debt would be $${stress.debt_usd} · HF ${fmtHf(stress.health_factor)} · status ${stress.status.toUpperCase()}`],
  });
}

function fmtHf(hf: number): string {
  return hf === Infinity ? "∞" : hf.toFixed(2);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
