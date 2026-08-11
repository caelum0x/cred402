/**
 * automations_run.ts — Credit Automations end to end.
 *
 * An agent declares its own credit policy up front: "if my health factor drops below
 * 1.4, deleverage to 2.0" and "if XRP/USD rises above $0.40, de-risk". It then draws a
 * position, and a single tick of the Automation engine evaluates every rule against
 * the live FTSO price + position health and autonomously executes the ones that fire —
 * each deleverage running through KeeperHub (simulate → smart gas → private → audit).
 * A second tick shows the rules are idempotent once the position is safe.
 *
 *   npm run automations:run
 *
 * With KEEPERHUB_API_KEY set, each automation is also registered as a KeeperHub
 * workflow (create_workflow + validated cron) so it can be scheduled there.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { PositionEngine } from "../lib/flare/positions.js";
import { AutomationEngine } from "../lib/flare/automations.js";
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
  const autos = new AutomationEngine();

  banner("Cred402 Credit Automations — declare a policy, KeeperHub runs it");

  // 1) Declare two automations.
  const a1 = await autos.register({
    agent_id: agentId,
    name: "guard-hf-1.4",
    trigger: { kind: "health_below", threshold: 1.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });
  const a2 = await autos.register({
    agent_id: agentId,
    name: "derisk-if-xrp-above-0.40",
    trigger: { kind: "price_above", price: 0.4 },
    action: { kind: "deleverage", target_hf: 2.0 },
  });
  scene({
    scene: "Declared automations",
    lines: [
      `${a1.name}: ${a1.trigger.kind} → ${a1.action.kind} (id ${a1.id})`,
      `${a2.name}: ${a2.trigger.kind} → ${a2.action.kind} (id ${a2.id})`,
      `KeeperHub workflow ids: ${a1.keeperhub_workflow_id ?? "(local — set KEEPERHUB_API_KEY to register)"}`,
    ],
  });

  // 2) Draw a position that trips both triggers.
  await flare.draw(agentId, 8500n * 1_000_000n);
  const before = await engine.assess(agentId);
  scene({
    scene: "Agent draws 8,500 FXRP",
    lines: [`debt $${before.debt_usd} · HF ${fmtHf(before.health_factor)} · status ${before.status.toUpperCase()} · FTSO $${before.xrp_usd}`],
  });

  // 3) Tick — evaluate + execute due automations via KeeperHub.
  const runs = await autos.tick({ satellite: flare, ledger });
  for (const r of runs) {
    scene({
      scene: `Automation fired: ${r.name}`,
      lines: [
        `trigger: ${r.reason}`,
        `action: ${r.action}${r.amount_fxrp ? ` ${r.amount_fxrp} FXRP` : ""} · ok=${r.ok}`,
        r.tx_hash ? `tx ${r.tx_hash.slice(0, 18)}… · audit ${r.keeperhub_audit_id ?? "n/a"}` : "",
        r.explorer_url ? `explorer ${r.explorer_url}` : "",
      ].filter(Boolean),
    });
  }

  const after = await engine.assess(agentId);
  scene({ scene: "Position after automations", lines: [`debt $${after.debt_usd} · HF ${fmtHf(after.health_factor)} · status ${after.status.toUpperCase()}`] });

  // 4) Second tick — idempotent: the cured position no longer trips health_below.
  const runs2 = await autos.tick({ satellite: flare, ledger });
  const fired2 = runs2.filter((r) => r.action !== "notify" && (r.amount_fxrp ?? 0) > 0);
  scene({
    scene: "Second tick (idempotency)",
    lines: [`${runs2.length} automation(s) evaluated as due, ${fired2.length} performed a repay — position already safe`],
  });

  scene({ scene: "KeeperHub reliability", lines: [JSON.stringify(flare.reliability())] });
}

function fmtHf(hf: number): string {
  return hf === Infinity ? "∞" : hf.toFixed(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
