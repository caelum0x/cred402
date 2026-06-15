/**
 * steps.ts — run individual stages of the loop, matching the spec's CLI:
 *   pnpm demo:request-evidence
 *   pnpm demo:pay-x402
 *   pnpm demo:submit-evidence
 *   pnpm demo:score-agent
 *
 * Each step builds a fresh bootstrapped economy and runs up to the requested
 * stage, printing what an operator would see at that point.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { scene, banner } from "./render.js";

const step = process.argv[2] ?? "request-evidence";

function build(): Cred402Economy {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  return econ;
}

switch (step) {
  case "request-evidence": {
    banner("Step: request evidence");
    const econ = build();
    scene(econ.createJob());
    break;
  }
  case "pay-x402": {
    banner("Step: pay via x402");
    const econ = build();
    econ.createJob();
    const { log } = await econ.runEvidencePurchases();
    scene(log);
    break;
  }
  case "submit-evidence": {
    banner("Step: submit evidence + watchdog audit");
    const econ = build();
    econ.createJob();
    const { reports } = await econ.runEvidencePurchases();
    scene((await econ.runWatchdogAudit(reports)).log);
    scene(econ.scoreJob());
    break;
  }
  case "score-agent": {
    banner("Step: underwrite agent + open credit line");
    const econ = build();
    econ.createJob();
    const { reports } = await econ.runEvidencePurchases();
    await econ.runWatchdogAudit(reports);
    econ.scoreJob();
    scene(econ.underwriteSeller().log);
    scene(econ.drawCredit(6));
    break;
  }
  default:
    console.error(`unknown step: ${step}`);
    process.exit(1);
}
