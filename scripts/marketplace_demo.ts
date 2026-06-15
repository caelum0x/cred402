/**
 * marketplace_demo.ts — p4 §18 (marketplace), §11 (economics/fees) and §26
 * (cross-chain trust ladder) end to end.
 *
 *   npm run demo:marketplace
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { cspr, formatCspr } from "../lib/core/units.js";
import { Marketplace } from "../lib/services/marketplace.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { FinalityPolicy } from "../crosschain/trust-ladder/finality.js";
import { MultiRelayerCoordinator } from "../crosschain/trust-ladder/multi_relayer.js";
import { ProofTypeRegistry } from "../crosschain/trust-ladder/proof_types.js";
import { generateAgentKeypair } from "../lib/x402/keys.js";
import { banner, scene } from "./render.js";

function main(): void {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const seller = econ.seller.agent_id;

  banner("Cred402 marketplace · economics · trust ladder");

  // 1. Marketplace (p4 §18): list services across pricing strategies.
  const mkt = new Marketplace(ledger);
  mkt.list({ agent_id: seller, category: "rwa.energy_output", strategy: "fixed", base_price: cspr("0.002") });
  const dyn = mkt.list({ agent_id: seller, category: "rwa.weather_risk", strategy: "dynamic", base_price: cspr("0.002") });
  const rep = mkt.list({ agent_id: seller, category: "rwa.weather_risk", strategy: "reputation_tiered", base_price: cspr("0.002") });
  const cost = mkt.list({ agent_id: seller, category: "rwa.payment_monitoring", strategy: "data_cost_plus", base_price: cspr("0.001"), margin_bps: 2500n });
  scene({
    scene: "Marketplace — list paid services (p4 §18)",
    lines: [
      `${mkt.enriched().length} listings across ${new Set(mkt.enriched().map((l) => l.category)).size} categories`,
      `dynamic quote @ full load: ${formatCspr(mkt.quote(dyn.listing_id, { load: 1 }).price)} CSPR`,
      `reputation-tiered quote: ${formatCspr(mkt.quote(rep.listing_id).price)} CSPR (${mkt.quote(rep.listing_id).breakdown})`,
      `data-cost-plus quote (data 0.01): ${formatCspr(mkt.quote(cost.listing_id, { data_cost: cspr("0.01") }).price)} CSPR`,
      `top listing: ${mkt.enriched()[0]?.agent_id} rep ${mkt.enriched()[0]?.reputation_score}, chains ${mkt.enriched()[0]?.supported_chains.join("/")}`,
    ],
  });

  // 2. Economics (p4 §11): fee model + honest pool yield.
  const pe = new ProtocolEconomics();
  const interest = cspr(10);
  const split = pe.slashSplit(cspr(100));
  const health = pe.poolHealth({
    total_liquidity: cspr(1000),
    outstanding_credit: cspr(500),
    interest_accrued: cspr(50),
    fees_collected: cspr(5),
    default_losses: 0n,
    elapsed_seconds: 365 * 24 * 60 * 60,
  });
  scene({
    scene: "Protocol economics — fees + LP yield (p4 §11)",
    lines: [
      `facilitator fee on 100 CSPR: ${formatCspr(pe.facilitatorFee(cspr(100)))} CSPR (0.30%)`,
      `origination fee on 40 CSPR: ${formatCspr(pe.originationFee(cspr(40)))} CSPR (0.50%)`,
      `interest split on 10 CSPR → protocol ${formatCspr(pe.protocolInterestShare(interest))} / LPs ${formatCspr(pe.lpInterestShare(interest))}`,
      `slash 100 CSPR → victim ${formatCspr(split.to_victim)} / insurance ${formatCspr(split.to_insurance)} / treasury ${formatCspr(split.to_treasury)}`,
      `pool realized APY: ${(health.realized_apy * 100).toFixed(2)}% (utilization ${(health.utilization * 100).toFixed(0)}%, no fake APY)`,
    ],
  });

  // 3. Trust ladder (p4 §26): multi-relayer + finality + proof types.
  const chain = "eip155:8453";
  const coord = new MultiRelayerCoordinator(chain, 2, 60);
  const r1 = coord.registerRelayer(generateAgentKeypair(), cspr(100));
  const r2 = coord.registerRelayer(generateAgentKeypair(), cspr(100));
  const liar = coord.registerRelayer(generateAgentKeypair(), cspr(100));
  coord.submit(r1.attest(chain, 1, "0xROOT"));
  coord.submit(r2.attest(chain, 1, "0xROOT"));
  coord.submit(liar.attest(chain, 1, "0xFORGED"));
  const status = coord.finalize(1, 0, 120);
  const fp = new FinalityPolicy();
  const registry = ProofTypeRegistry.withDefaults();
  scene({
    scene: "Cross-chain trust ladder (p4 §26)",
    lines: [
      `stage 2 multi-relayer: root ${status.agreed_root} finalized by ${status.attesters.length} relayers`,
      `stage 2 fraud proof: liar slashed ${formatCspr(coord.relayer(liar.key)!.slashed)} CSPR bond`,
      `stage 3 finality: Base receipt final after 20 confs + 24s → ${fp.isFinal(chain, 100, 130, 0, 100).final}`,
      `stage 4 proof types supported now: ${registry.supported().join(", ")}`,
      `stage 4 honesty: zk verifier → ${registry.verify({ type: "zk" }).reason}`,
    ],
  });

  banner("Distribution (marketplace) + sustainability (fees) + safety (trust ladder)");
}

main();
