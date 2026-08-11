/**
 * grand_demo.ts — the whole Cred402 hackathon story in one run.
 *
 * A single agent walks the entire arc: it earns x402 revenue, gets a confidential
 * (TEE-attested) credit score, draws FXRP credit through KeeperHub, has its position
 * marked to FTSO and auto-deleveraged by the keeper, sets a declarative automation,
 * posts multi-asset collateral, mints FXRP from attested XRP, sells a credit service
 * over x402, and finally the scheduler runs the whole last mile on a cadence.
 *
 * This is the script to screen-record for the KeeperHub + Flare submissions.
 *
 *   npm run demo:grand
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { RiskEngineV2 } from "../lib/services/risk_engine_v2.js";
import { Cred402CreditOracle } from "../lib/services/credit_oracle.js";
import { ConfidentialScorer } from "../lib/flare/confidential_score.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { PositionEngine } from "../lib/flare/positions.js";
import { CreditKeeper } from "../lib/flare/keeper.js";
import { AutomationEngine } from "../lib/flare/automations.js";
import { FAssetsMinter } from "../lib/flare/fassets_mint.js";
import { CreditServiceMarketplace } from "../lib/services/x402_marketplace.js";
import { AutonomousScheduler } from "../lib/keeperhub/index.js";
import { signPayment } from "../lib/x402/index.js";
import { fxrpToXrp } from "../packages/chain-adapters/src/index.js";
import { banner, scene, note } from "./render.js";

async function main(): Promise<void> {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  econ.createJob();
  const agentId = econ.seller.agent_id;

  banner("Cred402 — the last mile for autonomous on-chain credit (KeeperHub × Flare)");
  note("One agent. The whole arc: earn → score → borrow → manage → automate → collateralize → mint → sell → schedule.");

  // 1 — Earn x402 revenue (the raw creditworthiness signal).
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.applyReputationEngine();
  econ.scoreJob();
  econ.underwriteSeller();
  const check = new Cred402CreditOracle(ledger).creditCheck(agentId);
  scene({
    scene: "1 · Earn x402 revenue → creditworthy",
    lines: [`agent ${agentId}`, `reputation ${ledger.agents.get(agentId)!.reputation_score} · credit check: exists ${check.exists}, score ${check.credit_score}, eligible ${check.eligible}`],
  });

  // 2 — Confidential credit score (Flare Confidential Compute).
  const rs = new RiskEngineV2(ledger).score(agentId);
  if (!("error" in rs)) {
    const att = await new ConfidentialScorer().score(rs.agent_id, rs.features);
    scene({
      scene: "2 · Flare Confidential Compute — attested score, private inputs",
      lines: [`score ${att.score}/100 (${att.risk_band}) · enclave ${att.enclave.platform} · verified ${att.enclave.verified}`, `raw cash-flow features never leave the enclave (commitment ${att.input_commitment.slice(0, 14)}…)`],
    });
  }

  // 3 — Draw FXRP credit, executed through KeeperHub.
  const flare = new FlareCreditSatellite(ledger);
  const engine = new PositionEngine(flare.vault, ledger, flare.priceClient, {}, flare.collateral);
  const draw = await flare.draw(agentId, 8500n * 1_000_000n);
  const audit = flare.auditTrail(agentId).at(-1);
  scene({
    scene: "3 · Draw 8,500 FXRP — Casper approves, Flare lends, KeeperHub executes",
    lines: [
      `${draw.amount_xrp} FXRP ≈ $${draw.usd_value} @ FTSO $${draw.xrp_usd} (${draw.price_source})`,
      `KeeperHub: simulate ✓ · gas ${audit?.gas.strategy} · private ${audit?.private_routed} · ${audit?.payment.protocol} · tx ${draw.tx_hash.slice(0, 14)}…`,
      draw.explorer_url,
    ],
  });

  // 4 — Position health (FTSO) + autonomous keeper deleverage.
  const before = await engine.assess(agentId);
  const keeperRun = await new CreditKeeper(flare, ledger).run(agentId);
  const after = await engine.assess(agentId);
  scene({
    scene: "4 · FTSO position health → keeper auto-deleverages a margin call",
    lines: [
      `HF ${fmtHf(before.health_factor)} (${before.status}) → keeper ${keeperRun.action} ${keeperRun.amount_fxrp} FXRP → HF ${fmtHf(after.health_factor)} (${after.status})`,
      `executed via KeeperHub (audit ${keeperRun.keeperhub_audit_id?.slice(0, 12)}…)`,
    ],
  });

  // 5 — Declarative automation.
  const autos = new AutomationEngine();
  const auto = await autos.register({ agent_id: agentId, name: "guard-hf-1.4", trigger: { kind: "health_below", threshold: 1.4 }, action: { kind: "deleverage", target_hf: 2.0 } });
  scene({ scene: "5 · Credit automation — declare a policy, KeeperHub runs it", lines: [`${auto.name}: ${auto.trigger.kind} → ${auto.action.kind} (cron ${auto.cron ?? "trigger"})`] });

  // 6 — FTSO-priced multi-asset collateral.
  flare.collateral.deposit(agentId, "BTC", 0.05);
  flare.collateral.deposit(agentId, "ETH", 1);
  const cval = await flare.collateral.valueUsd(agentId);
  const withColl = await engine.assess(agentId);
  scene({
    scene: "6 · FTSO-priced collateral expands borrowing power",
    lines: [`posted ${cval.lines.map((l) => `${l.amount_whole} ${l.symbol}`).join(" + ")} = $${cval.total_value_usd} → +$${cval.borrowing_power_usd} power`, `borrowing power now $${withColl.borrowing_power_usd} (HF ${fmtHf(withColl.health_factor)})`],
  });

  // 7 — FAssets: mint FXRP from attested XRP.
  const minter = new FAssetsMinter();
  const mint = await minter.mint(agentId, 3000n * 1_000_000n);
  scene({ scene: "7 · FAssets — mint FXRP from FDC-attested XRP", lines: [`minted ${fxrpToXrp(BigInt(mint.fxrp_minted))} FXRP · FDC verified ${mint.fdc_verified} (${mint.fdc_source})`, `XRP liquidity → usable Flare credit collateral`] });

  // 8 — Sell a credit service over x402 (revenue → reputation loop).
  const market = new CreditServiceMarketplace(agentId, async (id) => ({ ran: id, credit: check }));
  const challenged = await market.call("credit-check", undefined, { agent_id: agentId });
  const challenge = (challenged as { body: { challenge: Parameters<typeof signPayment>[0]["challenge"] } }).body.challenge;
  const { header } = signPayment({ challenge, payer_agent: econ.buyer.agent_id, payer_public_key: econ.buyer.publicKeyHex, payer_private_pem: econ.buyer.keys.privatePem });
  const paid = await market.call("credit-check", header, { agent_id: agentId });
  scene({ scene: "8 · Sell a credit service over x402 (402 → pay → 200)", lines: [`paid by ${paid.kind === "paid" ? paid.payer_agent : "?"} · receipt ${paid.kind === "paid" ? paid.receipt.receipt_id : "?"}`, `revenue ${Number(market.stats().total_revenue_motes) / 1e9} CSPR — becomes Cred402's own on-chain reputation`] });

  // 9 — The scheduler runs the last mile on a cadence.
  let clock = 2000;
  const scheduler = new AutonomousScheduler(() => clock);
  scheduler.addJob({ name: "keeper-sweep", interval_sec: 60, run: () => new CreditKeeper(flare, ledger).runFleet(ledger.agents.list().map((a) => a.agent_id)) });
  scheduler.addJob({ name: "automation-tick", interval_sec: 30, run: () => autos.tick({ satellite: flare, ledger, now: clock }) });
  const runs = await scheduler.tick();
  scene({ scene: "9 · Autonomous scheduler — the last mile, on a cadence", lines: runs.map((r) => `▶ ${r.job}: ${r.summary ?? "done"}`) });

  // Close — the reliability envelope that ran under all of it.
  banner("Every on-chain action ran through KeeperHub with full observability");
  scene({ scene: "KeeperHub reliability", lines: [JSON.stringify(flare.reliability())] });
  note("Flare Coston2 explorer links are printed above; set KEEPERHUB_API_KEY + FLARE_RPC_URL to execute for real.");
}

function fmtHf(hf: number): string {
  return hf === Infinity ? "∞" : hf.toFixed(2);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
