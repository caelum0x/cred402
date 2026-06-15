/**
 * multichain_demo.ts — p3 end to end: Casper-rooted, chain-executed.
 *
 * An agent binds an EVM address, earns x402 revenue on Base, anchors the receipt
 * to Casper (reputation settles on Casper), then borrows on the EVM satellite vault
 * ONLY against a Casper-issued, global-exposure-checked Credit Authorization Note —
 * and repays, releasing exposure.
 *
 *   pnpm tsx scripts/multichain_demo.ts
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { generateEvmKeypair } from "../lib/x402/evm.js";
import { buildAddressBinding, buildUniversalReceipt } from "../crosschain/standards/index.js";
import { makeCaid } from "../crosschain/standards/identity.js";
import { CasperAdapter, EvmAdapter, EvmSatelliteVault } from "../packages/chain-adapters/src/index.js";
import { CasperRootRelayer } from "../crosschain/relayers/casper_root_relayer.js";
import { ProofService } from "../crosschain/proof-service/proof_service.js";
import { banner, scene } from "./render.js";

const BASE = "eip155:8453";
const POOL = "0xbASEpoolcred402vault00000000000000000001";

async function main(): Promise<void> {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const agentId = econ.seller.agent_id;
  const caid = makeCaid(agentId);

  const casper = new CasperAdapter(ledger);
  const vault = new EvmSatelliteVault(BASE, POOL, ledger.policyPublicKeyHex, 1_000_000_000n); // $1,000 USDC
  const evm = new EvmAdapter(BASE, vault, () => ledger.clock.now());
  // The relayer observes Base events, commits them to a signed Merkle root, and
  // anchors the proven facts to the Casper root. No fact reaches Casper without a
  // verifiable proof — this is the real "Casper-rooted, chain-executed" bridge.
  const relayer = new CasperRootRelayer(evm, casper, new ProofService());

  banner("Cred402 omnichain — Casper-rooted, chain-executed");
  console.log(`  CAID: ${caid}`);
  console.log(`  Casper policy key: ${ledger.policyPublicKeyHex.slice(0, 18)}…\n`);

  // 1. Bind an EVM address to the Casper-rooted agent (dual-signed).
  const evmKeys = generateEvmKeypair();
  const abe = buildAddressBinding({
    agent_id: agentId,
    casper_account: econ.seller.publicKeyHex,
    casper_private_pem: econ.seller.keys.privatePem,
    external_chain: BASE,
    external_address: evmKeys.address,
    external_private_key: evmKeys.privateKey,
    expires_at: ledger.clock.now() + 31_536_000,
  });
  const boundCasper = await casper.bindAgentAddress(abe);
  await evm.bindAgentAddress(abe);
  scene({ scene: "Bind EVM address to Casper agent", lines: [`bound ${evmKeys.address} → ${agentId} (${boundCasper.ok ? "verified" : boundCasper.detail})`] });

  // 2. Agent earns 40 USDC on Base via x402; anchor the receipt to Casper.
  const { envelope: ure } = buildUniversalReceipt({
    origin_chain: BASE,
    settlement_network: "base",
    payer_agent_id: "rwa-request-agent-base",
    seller_agent_id: agentId,
    payer_address: "0x1111111111111111111111111111111111111111",
    seller_address: evmKeys.address,
    asset: "USDC",
    amount: "40000000", // 40 USDC (6dp)
    service_type: "rwa.weather_risk",
    request_hash: "0xreq",
    result_hash: "0xres",
    payment_proof_hash: "0xproof",
    settlement_tx_hash: "0xbasetx",
    nonce: "0xnonce-1",
    created_at: ledger.clock.now(),
  });
  await evm.submitReceipt(ure);
  const repBefore = ledger.agents.get(agentId)!.reputation_score;
  // The relayer observes the Base ReceiptCreated, proves it, and anchors to Casper.
  const relayed = await relayer.sync();
  const repAfter = ledger.agents.get(agentId)!.reputation_score;
  scene({
    scene: "Earn on Base → relayer anchors a PROVEN receipt to Casper",
    lines: [
      `relayer batch root ${relayed.batchRoot?.slice(0, 18)}… (${relayed.proofs.length} proofs, ${relayed.rejected} rejected)`,
      `anchored ${relayed.anchored} receipt; reputation ${repBefore} → ${repAfter} (trust settled on Casper)`,
    ],
  });

  // 3. Casper issues a Credit Authorization Note (reserves global exposure).
  const agent = ledger.agents.get(agentId)!;
  ledger.exposure.ensure_agent(agentId, 2_000_000_000n); // $2,000 global cap
  const can = ledger.notes.issue_can({
    agent_id: agentId,
    credit_score: Math.max(agent.credit_score, 80),
    risk_policy_version: 1,
    target_chain: BASE,
    target_pool: POOL,
    max_draw: 500_000_000n, // up to $500
    asset: "USDC",
  });
  const ex = ledger.exposure.get_agent_global_exposure(agentId)!;
  scene({
    scene: "Casper issues a Credit Authorization Note",
    lines: [`CAN ${can.note_id.slice(0, 18)}… max_draw $${Number(can.max_draw) / 1e6}`, `global exposure reserved $${Number(ex.reserved) / 1e6} / cap $${Number(ex.max_allowed) / 1e6}`],
  });

  // 4. EVM vault verifies the CAN and lends $300; relayer reconciles exposure on Casper.
  const draw = await evm.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
  if (!draw.ok) throw new Error(`draw failed: ${draw.detail}`);
  const drawRelay = await relayer.sync();
  const exAfter = ledger.exposure.get_agent_global_exposure(agentId)!;
  scene({
    scene: "Borrow $300 on Base under Casper risk control",
    lines: [
      `vault lent $300 (tx ${draw.tx_hash.slice(0, 14)}…), vault liquidity now $${Number(vault.availableLiquidity()) / 1e6}`,
      `relayer reconciled ${drawRelay.drawsReconciled} draw → Casper outstanding exposure $${Number(exAfter.outstanding) / 1e6}`,
    ],
  });

  // 5. Repay on Base; relayer reports repayment → Casper releases exposure.
  await evm.repayCredit({ agent_id: agentId, amount: "300000000" });
  const repayRelay = await relayer.sync();
  const exFinal = ledger.exposure.get_agent_global_exposure(agentId)!;
  scene({
    scene: "Repay on Base → relayer releases exposure on Casper",
    lines: [
      `vault debt now $${Number(vault.debtOf(agentId)) / 1e6}`,
      `relayer reconciled ${repayRelay.repaymentsReconciled} repayment → Casper outstanding exposure $${Number(exFinal.outstanding) / 1e6}`,
    ],
  });

  banner("Casper decided who is creditworthy. Base executed the credit.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
