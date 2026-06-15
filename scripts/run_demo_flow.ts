/**
 * run_demo_flow.ts — the full Cred402 magic loop, end to end.
 *
 *   pnpm demo            honest happy-path loop
 *   pnpm demo:dispute    stretch: falsified evidence -> watchdog slashing
 *
 * Runs entirely against the in-memory Casper ledger simulation so the whole
 * agent economy is reproducible without a funded Testnet wallet.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { formatCspr } from "../lib/core/units.js";
import { banner, scene, note } from "./render.js";

async function main(): Promise<void> {
  const dispute = process.argv.includes("--dispute");
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);

  banner("Cred402 — credit lines for autonomous RWA agents on Casper");
  note(`Deployed contracts (simulated Testnet):`);
  for (const [name, hash] of Object.entries(ledger.contractHashes)) note(`  ${name}: ${hash}`);
  note(`Active risk policy: ${ledger.policy.version()}`);

  scene(econ.bootstrap());
  scene(econ.createJob());

  const { log: buyLog, reports } = await econ.runEvidencePurchases({ tamperEnergy: dispute });
  scene(buyLog);

  const audit = await econ.runWatchdogAudit(reports);
  scene(audit.log);

  if (audit.disputed) {
    note("Falsified evidence detected — credit path halted, agent penalized.");
    printAgent(ledger, econ.seller.agent_id);
    printPolicyUpgrade(econ);
    summary(ledger);
    return;
  }

  scene(econ.applyReputationEngine());
  scene(econ.scoreJob());
  const { log: underwriteLog } = econ.underwriteSeller();
  scene(underwriteLog);
  scene(econ.drawCredit(6));
  scene(econ.repay(2));
  scene(econ.routeLiquidity());

  printAgent(ledger, econ.seller.agent_id);
  printPolicyUpgrade(econ);
  summary(ledger);
}

function printAgent(ledger: Ledger, agent_id: string): void {
  const a = ledger.agents.get(agent_id)!;
  const line = ledger.pool.get(agent_id);
  banner(`Agent profile — ${agent_id}`);
  console.log(`  reputation:    ${a.reputation_score}/100`);
  console.log(`  accuracy:      ${a.accuracy_score}/100`);
  console.log(`  dispute rate:  ${(a.dispute_rate * 100).toFixed(1)}%`);
  console.log(`  credit score:  ${a.credit_score}/100`);
  console.log(`  stake:         ${formatCspr(a.stake)} CSPR`);
  if (line) console.log(`  credit line:   ${formatCspr(line.drawn)} / ${formatCspr(line.max_credit)} CSPR (${line.status})`);
}

/** Demonstrate the upgradable risk policy: v1 -> v2 re-underwrite. */
function printPolicyUpgrade(econ: Cred402Economy): void {
  const seller = econ.ledger.agents.get(econ.seller.agent_id)!;
  if (econ.ledger.policy.version() !== "v1") return;
  const before = econ.ledger.policy.evaluate(seller).credit_line;
  econ.ledger.policy.upgrade("v2");
  const after = econ.ledger.policy.evaluate(seller).credit_line;
  banner("Upgradable contract demo — RiskPolicyManager v1 → v2");
  console.log(`  credit line under v1: ${formatCspr(before)} CSPR`);
  console.log(`  credit line under v2: ${formatCspr(after)} CSPR (throughput-weighted)`);
  console.log(`  policy swapped on-chain without redeploying the pool or registry.`);
}

function summary(ledger: Ledger): void {
  const pool = ledger.pool.poolState();
  banner("Ledger summary");
  console.log(`  agents:            ${ledger.agents.list().length}`);
  console.log(`  x402 receipts:     ${ledger.receipts.list().length}`);
  console.log(`  evidence records:  ${ledger.evidence.list().length}`);
  console.log(`  pool liquidity:    ${formatCspr(pool.total_liquidity)} CSPR`);
  console.log(`  outstanding credit:${formatCspr(pool.outstanding_credit)} CSPR`);
  console.log(`  defaults:          ${pool.defaults}`);
  console.log(`  chain events:      ${ledger.bus.all().length}`);
  console.log("");
}

main();
