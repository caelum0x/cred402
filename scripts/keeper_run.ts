/**
 * keeper_run.ts — the Autonomous Credit Keeper end to end.
 *
 * An agent draws a large FXRP position that carries real FTSO price risk. The keeper
 * marks the debt to the live FTSO XRP/USD price, sees the health factor breach the
 * margin-call threshold, and autonomously deleverages the position through KeeperHub
 * (simulate → smart gas → private routing → audit). It then stress-tests the cured
 * position against a hypothetical XRP price spike. Sim by default; set FLARE_RPC_URL /
 * KEEPERHUB_API_KEY for the real FTSO reads and real KeeperHub execution.
 *
 *   npm run keeper:run
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { PositionEngine } from "../lib/flare/positions.js";
import { CreditKeeper } from "../lib/flare/keeper.js";
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
  const engine = new PositionEngine(flare.vault, ledger, flare.priceClient);
  const keeper = new CreditKeeper(flare, ledger);

  banner("Cred402 Autonomous Credit Keeper — FTSO risk → KeeperHub execution");

  // 1) Draw a large FXRP position ($4,420 against a $5,000 cap) → margin call.
  const draw = await flare.draw(agentId, 8500n * 1_000_000n);
  const before = await engine.assess(agentId);
  scene({
    scene: "Agent draws 8,500 FXRP — position at risk",
    lines: [
      `debt ${before.fxrp_debt_whole} FXRP ≈ $${before.debt_usd} (FTSO $${before.xrp_usd}, ${before.price_source})`,
      `cap $${before.cap_usd} · health factor ${fmtHf(before.health_factor)} · status ${before.status.toUpperCase()}`,
      `draw tx ${draw.tx_hash.slice(0, 18)}…`,
    ],
  });

  // 2) The keeper checks the condition and autonomously executes a deleverage.
  const run = await keeper.run(agentId);
  scene({
    scene: "Keeper: check → execute (deleverage via KeeperHub)",
    lines: [
      `decision: ${run.action.toUpperCase()} ${run.amount_fxrp} FXRP`,
      run.reason,
      `executed=${run.executed} ok=${run.ok} tx ${run.tx_hash.slice(0, 18)}… audit ${run.keeperhub_audit_id ?? "n/a"}`,
      run.explorer_url ? `explorer ${run.explorer_url}` : "",
    ].filter(Boolean),
  });

  // 3) Position after the keeper acted.
  const after = await engine.assess(agentId);
  scene({
    scene: "Position cured",
    lines: [
      `debt now ${after.fxrp_debt_whole} FXRP ≈ $${after.debt_usd} · health factor ${fmtHf(after.health_factor)} · status ${after.status.toUpperCase()}`,
    ],
  });

  // 4) Stress test: what if XRP/USD doubles from here?
  const stress = await engine.assess(agentId, { priceOverride: after.xrp_usd * 2 });
  scene({
    scene: `Stress test — what if XRP/USD = $${round2(after.xrp_usd * 2)}`,
    lines: [
      `debt would be $${stress.debt_usd} · health factor ${fmtHf(stress.health_factor)} · status ${stress.status.toUpperCase()}`,
      stress.deleverage_fxrp > 0 ? `keeper would deleverage ${stress.deleverage_fxrp} FXRP` : "still within safe bounds",
    ],
  });

  scene({ scene: "KeeperHub reliability", lines: [JSON.stringify(flare.reliability())] });
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
