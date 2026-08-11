/**
 * scheduler_run.ts — the Autonomous Scheduler (KeeperHub cron) end to end.
 *
 * The scheduler runs the last mile on a cadence: a keeper fleet sweep and a credit
 * automation tick, each on its own interval. It CHECKS every position/rule and
 * EXECUTES the due protective actions through KeeperHub — unattended. This drives the
 * whole system forward with no human in the loop.
 *
 *   npm run scheduler:run
 *
 * The scheduler's tick(now) core is deterministic, so this demo drives it by hand
 * across a simulated timeline instead of waiting on real timers.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { CreditKeeper } from "../lib/flare/keeper.js";
import { AutomationEngine } from "../lib/flare/automations.js";
import { AutonomousScheduler } from "../lib/keeperhub/index.js";
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
  const autos = new AutomationEngine();
  await autos.register({ agent_id: agentId, name: "guard-hf-1.4", trigger: { kind: "health_below", threshold: 1.4 }, action: { kind: "deleverage", target_hf: 2.0 } });

  // Drive the scheduler on a simulated clock so the demo is deterministic.
  let clock = 1000;
  const scheduler = new AutonomousScheduler(() => clock);
  scheduler.addJob({ name: "keeper-sweep", interval_sec: 60, run: () => new CreditKeeper(flare, ledger).runFleet(ledger.agents.list().map((a) => a.agent_id)) });
  scheduler.addJob({ name: "automation-tick", interval_sec: 30, run: () => autos.tick({ satellite: flare, ledger, now: clock }) });

  banner("Cred402 Autonomous Scheduler — the last mile, on a cadence");
  scene({
    scene: "Scheduler jobs",
    lines: scheduler.status().jobs.map((j) => `${j.name}: every ${j.interval_sec}s (${j.enabled ? "enabled" : "disabled"})`),
  });

  // t=1000: agent draws a risky FXRP position (margin call).
  await flare.draw(agentId, 8500n * 1_000_000n);
  scene({ scene: "t=1000 — agent draws 8,500 FXRP (margin call)", lines: ["position is now under-collateralized; no human is watching"] });

  // First tick: both jobs are due (never run) → keeper deleverages, automation fires.
  let runs = await scheduler.tick();
  logRuns("t=1000 — first tick (all jobs due)", runs);

  // t=1030: only the 30s automation job is due again.
  clock = 1030;
  runs = await scheduler.tick();
  logRuns("t=1030 — automation-tick due again (keeper-sweep not yet)", runs);

  // t=1070: both due again — position already safe, so actions are no-ops.
  clock = 1070;
  runs = await scheduler.tick();
  logRuns("t=1070 — both due (position already cured → no-ops)", runs);

  const st = scheduler.status();
  scene({
    scene: "Scheduler status",
    lines: st.jobs.map((j) => `${j.name}: ${j.runs} run(s), next due at t=${j.next_due_at}`),
  });
}

function logRuns(label: string, runs: Array<{ job: string; ok: boolean; summary?: string; ms: number }>): void {
  scene({ scene: label, lines: runs.length ? runs.map((r) => `▶ ${r.job}: ok=${r.ok} — ${r.summary ?? "done"}`) : ["(no jobs due)"] });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
