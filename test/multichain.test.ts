import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { generateEvmKeypair } from "../lib/x402/evm.js";
import { buildAddressBinding, buildUniversalReceipt } from "../crosschain/standards/index.js";
import { CasperAdapter, EvmAdapter, EvmSatelliteVault, CosmosAdapter, CosmosSatelliteVault, SolanaAdapter, SolanaSatelliteVault, MoveAdapter, MoveSatelliteVault } from "../packages/chain-adapters/src/index.js";

const BASE = "eip155:8453";
const POOL = "0xpool00000000000000000000000000000000pool";

function setup() {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  const casper = new CasperAdapter(ledger);
  const vault = new EvmSatelliteVault(BASE, POOL, ledger.policyPublicKeyHex, 1_000_000_000n);
  const evm = new EvmAdapter(BASE, vault, () => ledger.clock.now());
  return { ledger, econ, casper, vault, evm, agentId: econ.seller.agent_id };
}

test("p3: external EVM receipt anchors to Casper and lifts reputation", async () => {
  const { ledger, econ, casper, evm, agentId } = setup();
  const evmKeys = generateEvmKeypair();
  const { envelope: ure } = buildUniversalReceipt({
    origin_chain: BASE, settlement_network: "base", payer_agent_id: "buyer", seller_agent_id: agentId,
    payer_address: "0x1", seller_address: evmKeys.address, asset: "USDC", amount: "40000000",
    service_type: "rwa.weather_risk", request_hash: "0xr", result_hash: "0xres",
    payment_proof_hash: "0xp", settlement_tx_hash: "0xtx", nonce: "0xn1", created_at: ledger.clock.now(),
  });
  await evm.submitReceipt(ure);
  const before = ledger.agents.get(agentId)!.reputation_score;
  const res = await casper.submitReceipt(ure);
  assert.equal(res.ok, true);
  assert.ok(ledger.agents.get(agentId)!.reputation_score >= before);
  assert.equal(ledger.externalReceipts.list().length, 1);
  // replay of the same URE is rejected
  const replay = await casper.submitReceipt(ure);
  assert.equal(replay.ok, false);
  void econ;
});

test("p3: EVM vault lends only against a valid Casper CAN; global exposure enforced", async () => {
  const { ledger, casper, vault, evm, agentId } = setup();
  ledger.exposure.ensure_agent(agentId, 2_000_000_000n);
  const can = ledger.notes.issue_can({
    agent_id: agentId, credit_score: 82, risk_policy_version: 1,
    target_chain: BASE, target_pool: POOL, max_draw: 500_000_000n, asset: "USDC",
  });

  // valid draw within CAN
  const draw = await evm.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
  assert.equal(draw.ok, true);
  await casper.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
  assert.equal(vault.debtOf(agentId), 300_000_000n);
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 300_000_000n);

  // a forged CAN (wrong signer) is rejected by the vault
  const other = new Ledger();
  const forged = other.notes;
  other.exposure.ensure_agent(agentId, 9_000_000_000n);
  const forgedCan = forged.issue_can({ agent_id: agentId, credit_score: 99, risk_policy_version: 1, target_chain: BASE, target_pool: POOL, max_draw: 900_000_000n, asset: "USDC" });
  const forgedDraw = await evm.drawCredit({ note: forgedCan, agent_id: agentId, amount: "900000000" });
  assert.equal(forgedDraw.ok, false);

  // repay releases exposure
  await evm.repayCredit({ agent_id: agentId, amount: "300000000" });
  await casper.repayCredit({ agent_id: agentId, amount: "300000000" });
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 0n);
});

const COSMOS = "cosmos:osmosis-1";
const COSMOS_POOL = "osmo1vaultcred402creditpool00000000000000000q";

test("p3: Cosmos satellite lends against a Casper CAN and shares the global cap with EVM", async () => {
  const { ledger, casper, vault, evm, agentId } = setup();
  ledger.exposure.ensure_agent(agentId, 500_000_000n); // $500 global cap across ALL chains

  const cosmosVault = new CosmosSatelliteVault(COSMOS, COSMOS_POOL, ledger.policyPublicKeyHex, 1_000_000_000n, "uusdc");
  const cosmos = new CosmosAdapter(COSMOS, cosmosVault, () => ledger.clock.now());
  assert.equal(cosmos.family(), "cosmos");

  // draw $300 on Base
  const evmCan = ledger.notes.issue_can({ agent_id: agentId, credit_score: 82, risk_policy_version: 1, target_chain: BASE, target_pool: POOL, max_draw: 300_000_000n, asset: "USDC" });
  assert.equal((await evm.drawCredit({ note: evmCan, agent_id: agentId, amount: "300000000" })).ok, true);
  await casper.drawCredit({ note: evmCan, agent_id: agentId, amount: "300000000" });

  // draw $150 on Cosmos — same Casper-rooted ceiling, second chain family
  const cosmosCan = ledger.notes.issue_can({ agent_id: agentId, credit_score: 82, risk_policy_version: 1, target_chain: COSMOS, target_pool: COSMOS_POOL, max_draw: 200_000_000n, asset: "USDC" });
  const cDraw = await cosmos.drawCredit({ note: cosmosCan, agent_id: agentId, amount: "150000000" });
  assert.equal(cDraw.ok, true);
  assert.match(cDraw.tx_hash, /^[0-9A-F]+$/); // uppercase-hex Cosmos tx hash
  await casper.drawCredit({ note: cosmosCan, agent_id: agentId, amount: "150000000" });

  assert.equal(cosmosVault.debtOf(agentId), 150_000_000n);
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 450_000_000n); // 300 + 150

  // a CAN scoped to Cosmos is NOT valid at the EVM vault (wrong target_chain)
  assert.equal((await evm.drawCredit({ note: cosmosCan, agent_id: agentId, amount: "10000000" })).ok, false);

  // the shared cap blocks a further Cosmos issuance beyond $500 total
  assert.throws(
    () => ledger.notes.issue_can({ agent_id: agentId, credit_score: 82, risk_policy_version: 1, target_chain: COSMOS, target_pool: COSMOS_POOL, max_draw: 100_000_000n, asset: "USDC" }),
    /global exposure cap exceeded/,
  );

  // repay both legs releases the whole cap
  await cosmos.repayCredit({ agent_id: agentId, amount: "150000000" });
  await casper.repayCredit({ agent_id: agentId, amount: "150000000" });
  await evm.repayCredit({ agent_id: agentId, amount: "300000000" });
  await casper.repayCredit({ agent_id: agentId, amount: "300000000" });
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 0n);
  assert.equal(vault.debtOf(agentId), 0n);
  assert.equal(cosmosVault.availableLiquidity(), 1_000_000_000n);
});

test("p3: Solana satellite executes credit against a Casper CAN with base58 signatures", async () => {
  const { ledger, casper, agentId } = setup();
  ledger.exposure.ensure_agent(agentId, 1_000_000_000n);
  const SOL = "solana:mainnet";
  const SOL_POOL = "Cred402Vau1tSo1anaCreditPoo1111111111111111";
  const solVault = new SolanaSatelliteVault(SOL, SOL_POOL, ledger.policyPublicKeyHex, 1_000_000_000n, "USDC");
  const solana = new SolanaAdapter(SOL, solVault, () => ledger.clock.now());
  assert.equal(solana.family(), "solana");

  const can = ledger.notes.issue_can({ agent_id: agentId, credit_score: 82, risk_policy_version: 1, target_chain: SOL, target_pool: SOL_POOL, max_draw: 200_000_000n, asset: "USDC" });
  const draw = await solana.drawCredit({ note: can, agent_id: agentId, amount: "120000000" });
  assert.equal(draw.ok, true);
  // base58 signature: no 0, O, I, or l characters
  assert.match(draw.tx_hash, /^[1-9A-HJ-NP-Za-km-z]+$/);
  await casper.drawCredit({ note: can, agent_id: agentId, amount: "120000000" });
  assert.equal(solVault.debtOf(agentId), 120_000_000n);
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 120_000_000n);

  // replay of the same CAN is rejected on-vault
  const replay = await solana.drawCredit({ note: can, agent_id: agentId, amount: "10000000" });
  assert.equal(replay.ok, false);

  await solana.repayCredit({ agent_id: agentId, amount: "120000000" });
  await casper.repayCredit({ agent_id: agentId, amount: "120000000" });
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 0n);
  assert.equal(solVault.availableLiquidity(), 1_000_000_000n);
});

test("p3: Move (Aptos) satellite executes credit against a Casper CAN with 0x-hex tx hashes", async () => {
  const { ledger, casper, agentId } = setup();
  ledger.exposure.ensure_agent(agentId, 1_000_000_000n);
  const MOVE = "move:aptos-mainnet";
  const MOVE_MODULE = "0xcred402vaultaptoscreditpool0000000000000000000000000000000000000a";
  const moveVault = new MoveSatelliteVault(MOVE, MOVE_MODULE, ledger.policyPublicKeyHex, 1_000_000_000n, "0x1::usdc::USDC");
  const move = new MoveAdapter(MOVE, moveVault, () => ledger.clock.now());
  assert.equal(move.family(), "move");

  const can = ledger.notes.issue_can({ agent_id: agentId, credit_score: 82, risk_policy_version: 1, target_chain: MOVE, target_pool: MOVE_MODULE, max_draw: 200_000_000n, asset: "USDC" });
  const draw = await move.drawCredit({ note: can, agent_id: agentId, amount: "90000000" });
  assert.equal(draw.ok, true);
  assert.match(draw.tx_hash, /^0x[0-9a-f]{64}$/); // 32-byte 0x-hex Aptos tx hash
  await casper.drawCredit({ note: can, agent_id: agentId, amount: "90000000" });
  assert.equal(moveVault.debtOf(agentId), 90_000_000n);
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 90_000_000n);

  await move.repayCredit({ agent_id: agentId, amount: "90000000" });
  await casper.repayCredit({ agent_id: agentId, amount: "90000000" });
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 0n);
  assert.equal(moveVault.availableLiquidity(), 1_000_000_000n);
});

test("p3: global exposure cap blocks over-borrow across chains", () => {
  const { ledger, agentId } = setup();
  ledger.exposure.ensure_agent(agentId, 500_000_000n); // $500 cap
  ledger.notes.issue_can({ agent_id: agentId, credit_score: 80, risk_policy_version: 1, target_chain: BASE, target_pool: POOL, max_draw: 400_000_000n, asset: "USDC" });
  // a second CAN that would exceed the global cap must fail
  assert.throws(
    () => ledger.notes.issue_can({ agent_id: agentId, credit_score: 80, risk_policy_version: 1, target_chain: "solana", target_pool: "P", max_draw: 200_000_000n, asset: "USDC" }),
    /global exposure cap exceeded/,
  );
});

test("p3: address binding requires both signatures", async () => {
  const { ledger, econ, casper, agentId } = setup();
  const evmKeys = generateEvmKeypair();
  const abe = buildAddressBinding({
    agent_id: agentId, casper_account: econ.seller.publicKeyHex, casper_private_pem: econ.seller.keys.privatePem,
    external_chain: BASE, external_address: evmKeys.address, external_private_key: evmKeys.privateKey,
    expires_at: ledger.clock.now() + 1000,
  });
  assert.equal((await casper.bindAgentAddress(abe)).ok, true);
  assert.ok(ledger.bindings.verify_binding(agentId, BASE, evmKeys.address));

  // tampered external address fails verification
  const bad = { ...abe, external_address: "0x000000000000000000000000000000000000dead" };
  assert.equal((await casper.bindAgentAddress(bad)).ok, false);
});
