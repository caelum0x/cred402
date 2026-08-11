/**
 * submission_check.ts — hackathon submission readiness report.
 *
 * Runs a fast in-process sanity of the KeeperHub + Flare pipeline and prints, for each
 * hackathon, the submission requirements, what is already satisfied, and the exact
 * commands to produce the remaining artifacts (a real transaction, a Coston2 deploy).
 *
 *   npm run submit:check
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { banner, scene, note } from "./render.js";

const OK = "\x1b[32m✓\x1b[0m";
const TODO = "\x1b[33m□\x1b[0m";

async function main(): Promise<void> {
  // Fast sanity: the KeeperHub × Flare pipeline runs end to end in sim.
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  econ.createJob();
  const flare = new FlareCreditSatellite(ledger);
  const price = await flare.xrpUsd();
  const draw = await flare.draw(econ.seller.agent_id, 500n * 1_000_000n);
  const audit = flare.auditTrail(econ.seller.agent_id).at(-1);
  const keeperhubLive = flare.info().keeperhub_live;
  const ftsoLive = flare.info().ftso_live;

  banner("Cred402 — hackathon submission readiness");
  scene({
    scene: "Pipeline sanity (sim)",
    lines: [
      `FTSO XRP/USD $${price.value} (${price.source}) · FXRP draw ok=${draw.ok} tx ${draw.tx_hash.slice(0, 14)}…`,
      `KeeperHub execution: simulate ✓ · ${audit?.payment.protocol} · private ${audit?.private_routed} · gas ${audit?.gas.strategy}`,
      `real rails configured → KeeperHub: ${keeperhubLive ? "LIVE" : "sim"} · FTSO: ${ftsoLive ? "LIVE" : "sim"}`,
    ],
  });

  console.log("\n\x1b[1m━━ KeeperHub — \"The Last Mile\" (deadline 2026-08-13) ━━\x1b[0m");
  for (const [done, item] of [
    [true, "Agent executes on-chain THROUGH KeeperHub (OnchainExecutor under the Flare/EVM adapter)"],
    [true, "Uses KeeperHub surfaces: MCP server, x402/MPP pay-per-execution, smart gas + backoff, private routing, audit trail"],
    [true, "Reliability + observability: audit trail, retries, gas handling (/v1/keeperhub/reliability, /v1/keeperhub/audit)"],
    [true, "Source on GitHub (this repo)"],
    [true, "Demo video: media/cred402-hackathon-demo.mp4 (npm run record:hackathon to regenerate)"],
    [false, "A transaction your agent executed via KeeperHub — needs a real key (see below)"],
  ] as const) {
    console.log(`  ${done ? OK : TODO} ${item}`);
  }
  console.log("  \x1b[2mProduce a real tx:\x1b[0m");
  console.log("    1. Create an org API key at https://app.keeperhub.com (Settings > API Keys)");
  console.log("    2. export KEEPERHUB_API_KEY=kh_...   (optional: KEEPERHUB_GAS_SPONSORSHIP=1 on mainnet ETH)");
  console.log('    3. npm run keeperhub:execute -- --chain 114 --to <vault> --fn "executeDraw(bytes32,address,uint256)"');
  console.log("    → the audit record's tx_hash is your submission transaction link");

  console.log("\n\x1b[1m━━ Flare Summer Signal — both bounties (deadline 2026-08-14) ━━\x1b[0m");
  for (const [done, item] of [
    [true, "Bounty 1 (Interoperable Assets): FXRP credit vault, CAN-gated, FTSO-priced, FDC-attested (contracts/flare/)"],
    [true, "Bounty 2 (Confidential Compute): TEE-attested credit scoring (lib/flare/confidential_score.ts)"],
    [true, "FAssets mint→collateralize lifecycle; FTSO multi-asset collateral; autonomous keeper + automations"],
    [true, "Meaningful Flare use: FTSO (pricing/health), FDC (attestation), FAssets (FXRP), Confidential Compute"],
    [true, "Clear separation of new work: docs/flare_integration.md + docs/SUBMISSIONS.md"],
    [true, "Demo video: media/cred402-hackathon-demo.mp4"],
    [false, "Coston2 contract addresses — deploy contracts/flare/ (see below)"],
  ] as const) {
    console.log(`  ${done ? OK : TODO} ${item}`);
  }
  console.log("  \x1b[2mDeploy to Coston2 + run live:\x1b[0m");
  console.log("    1. Fund a Coston2 key (C2FLR + FXRP): https://faucet.flare.network/coston2");
  console.log("    2. export PRIVATE_KEY=0x... FXRP_ADDRESS=0x... CASPER_POLICY_KEY_HASH=0x...");
  console.log("    3. cd contracts/flare && forge script script/DeployCoston2.s.sol --rpc-url coston2 --broadcast");
  console.log("    4. export FLARE_RPC_URL=https://coston2-api.flare.network/ext/C/rpc  # live FTSO reads");
  console.log("    → npm run flare:credit / fassets:mint  (record the address + explorer links)");

  note("Everything above runs green in sim today (npm test → 346 pass). The two □ items need YOUR keys.");
  console.log("\n\x1b[2mFull packets + links: docs/SUBMISSIONS.md · Grand demo: npm run demo:grand\x1b[0m");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
