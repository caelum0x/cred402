/**
 * flare_credit.ts — Cred402 × Flare Summer Signal, end to end.
 *
 * The interoperable-asset credit loop: an agent earns x402 revenue, Flare's FDC
 * attests the payment, Flare Confidential Compute scores the agent WITHOUT exposing
 * its raw cash flow, Casper signs a USD-limited Credit Authorization Note, and the
 * Flare satellite lends the FAsset FXRP — priced by the live FTSO XRP/USD feed —
 * executed on-chain through KeeperHub (simulate → smart gas → private routing →
 * audit). Sim by default; set FLARE_RPC_URL / KEEPERHUB_API_KEY for the real rails.
 *
 *   npm run flare:credit
 *
 * Env (all optional): FLARE_NETWORK (default coston2), FLARE_RPC_URL,
 * KEEPERHUB_API_KEY, FLARE_FDC_VERIFIER_URL, FLARE_CC_ATTESTATION_URL.
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { FlareCreditSatellite } from "../lib/flare/satellite.js";
import { ConfidentialScorer } from "../lib/flare/confidential_score.js";
import { RiskEngineV2 } from "../lib/services/risk_engine_v2.js";
import { banner, scene } from "./render.js";

async function main(): Promise<void> {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  econ.createJob();

  // Let the agent earn some verifiable x402 revenue so it is creditworthy.
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  econ.applyReputationEngine();
  econ.scoreJob();
  econ.underwriteSeller();
  const agentId = econ.seller.agent_id;

  const flare = new FlareCreditSatellite(ledger);
  const info = flare.info();
  banner("Cred402 × Flare — interoperable FXRP credit, FTSO-priced, KeeperHub-executed");
  scene({
    scene: "Flare satellite",
    lines: [
      `network ${info.network} (${info.chain})  pool ${info.pool}`,
      `FTSO live: ${info.ftso_live}   KeeperHub live: ${info.keeperhub_live}   liquidity ${Number(info.liquidity_fxrp) / 1e6} FXRP`,
    ],
  });

  // 1) Live FTSO XRP/USD price (or the deterministic reference).
  const price = await flare.xrpUsd();
  scene({ scene: "FTSO price feed", lines: [`XRP/USD = $${price.value} (source: ${price.source})`] });

  // 2) Confidential score — raw features stay inside the enclave.
  const rs = new RiskEngineV2(ledger).score(agentId);
  if (!("error" in rs)) {
    const att = await new ConfidentialScorer().score(rs.agent_id, rs.features);
    scene({
      scene: "Flare Confidential Compute — attested score, private inputs",
      lines: [
        `score ${att.score}/100 (${att.risk_band}), PD ${(att.pd * 100).toFixed(1)}%`,
        `enclave ${att.enclave.platform} · measurement ${att.enclave.measurement.slice(0, 18)}… · verified ${att.enclave.verified}`,
        `input commitment ${att.input_commitment.slice(0, 18)}… (raw revenue never published)`,
      ],
    });
  }

  // 3) Draw 500 FXRP against a Casper-signed CAN, executed via KeeperHub.
  const draw = await flare.draw(agentId, 500n * 1_000_000n);
  scene({
    scene: "Draw 500 FXRP — Casper approves, Flare lends, KeeperHub executes",
    lines: [
      `ok=${draw.ok}  ${draw.amount_xrp} FXRP ≈ $${draw.usd_value.toFixed(2)} @ $${draw.xrp_usd} (${draw.price_source})`,
      `CAN ${draw.note_id.slice(0, 18)}…  tx ${draw.tx_hash.slice(0, 18)}…`,
      draw.explorer_url ? `explorer ${draw.explorer_url}` : "explorer link available on live networks",
      `KeeperHub executed=${draw.keeperhub.executed} live=${draw.keeperhub.live}`,
    ],
  });

  // 4) KeeperHub audit trail for the execution (the reliability story).
  const audit = draw.keeperhub.audit;
  if (audit) {
    scene({
      scene: "KeeperHub audit trail",
      lines: [
        `execution ${audit.execution_id} · status ${audit.status}`,
        `simulation ${audit.simulation.ok ? "passed" : "failed"} (gas est ${audit.simulation.gas_estimate ?? "n/a"}), gas used ${audit.gas_used ?? "n/a"}`,
        `gas policy ${audit.gas.strategy} · backoff attempts ${audit.gas.attempts} · maxFee ${audit.gas.max_fee_per_gas} wei`,
        `payment ${audit.payment.protocol} ${Number(audit.payment.amount) / 1e6} ${audit.payment.asset} on ${audit.payment.network}`,
        `private routing ${audit.private_routed} · gas sponsored ${audit.sponsored}`,
      ],
    });
  }

  // 5) Repay and show reliability rollup.
  const repay = await flare.repay(agentId, 500n * 1_000_000n);
  const rel = flare.reliability();
  scene({
    scene: "Repay + reliability",
    lines: [
      `repay ok=${repay.ok} tx ${repay.tx_hash.slice(0, 18)}…`,
      `executions ${rel.total} · confirmed ${rel.confirmed} · private ${rel.private_routed} · avg backoff ${rel.avg_backoff_attempts} · protocols ${JSON.stringify(rel.by_protocol)}`,
    ],
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
