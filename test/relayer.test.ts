import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { generateEvmKeypair } from "../lib/x402/evm.js";
import { buildUniversalReceipt } from "../crosschain/standards/index.js";
import { CasperAdapter, EvmAdapter, EvmSatelliteVault } from "../packages/chain-adapters/src/index.js";
import { CasperRootRelayer } from "../crosschain/relayers/casper_root_relayer.js";
import { ProofService } from "../crosschain/proof-service/proof_service.js";
import { buildMerkleTree, verifyMerkleProof } from "../crosschain/proof-service/merkle.js";

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

function receipt(ledger: Ledger, agentId: string, sellerAddr: string, nonce: string) {
  return buildUniversalReceipt({
    origin_chain: BASE, settlement_network: "base", payer_agent_id: "buyer", seller_agent_id: agentId,
    payer_address: "0x1", seller_address: sellerAddr, asset: "USDC", amount: "40000000",
    service_type: "rwa.weather_risk", request_hash: "0xr", result_hash: "0xres",
    payment_proof_hash: "0xp", settlement_tx_hash: "0xtx", nonce, created_at: ledger.clock.now(),
  }).envelope;
}

test("merkle: every leaf in a batch produces a valid inclusion proof (odd + even sizes)", () => {
  for (const n of [1, 2, 3, 5, 8, 9]) {
    const leaves = Array.from({ length: n }, (_, i) => `event-${i}`);
    const { root, proofs } = buildMerkleTree(leaves);
    assert.equal(proofs.length, n);
    for (const p of proofs) assert.ok(verifyMerkleProof(p, root), `n=${n} idx=${p.index}`);
    // a proof must not verify against a different root
    assert.equal(verifyMerkleProof(proofs[0]!, "0xdeadbeef"), false);
  }
});

test("proof-service: commits a signed batch and verifies inclusion + relayer signature", () => {
  const svc = new ProofService();
  const batch = svc.commitBatch([
    { origin_chain: BASE, event_type: "ReceiptCreated", observed_at: 0, payload: { a: 1 } },
    { origin_chain: BASE, event_type: "CreditDrawn", observed_at: 1, payload: { b: 2 } },
  ]);
  assert.equal(batch.proofs.length, 2);
  const trusted = new Set([svc.relayerKey]);
  for (const p of batch.proofs) assert.equal(ProofService.verify(p, trusted).ok, true);

  // tampered payload breaks the payload_hash / leaf
  const tampered = { ...batch.proofs[0]!, payload: { a: 999 } };
  assert.equal(ProofService.verify(tampered, trusted).ok, false);

  // a proof from an untrusted relayer key is rejected
  assert.equal(ProofService.verify(batch.proofs[0]!, new Set(["01ff"])).ok, false);

  // forged root signature (swap to a different relayer's signature) is rejected
  const other = new ProofService();
  const forged = { ...batch.proofs[0]!, root_signature: other.commitBatch([
    { origin_chain: BASE, event_type: "ReceiptCreated", observed_at: 0, payload: { a: 1 } },
  ]).signature };
  assert.equal(ProofService.verify(forged, trusted).ok, false);
});

test("proof-service: refuses to batch events from multiple origin chains", () => {
  const svc = new ProofService();
  assert.throws(
    () => svc.commitBatch([
      { origin_chain: BASE, event_type: "ReceiptCreated", observed_at: 0, payload: {} },
      { origin_chain: "solana", event_type: "ReceiptCreated", observed_at: 1, payload: {} },
    ]),
    /single origin chain/,
  );
});

test("relayer: anchors a proven Base receipt to Casper and lifts reputation", async () => {
  const { ledger, casper, evm, agentId } = setup();
  const relayer = new CasperRootRelayer(evm, casper, new ProofService());
  const evmKeys = generateEvmKeypair();
  await evm.submitReceipt(receipt(ledger, agentId, evmKeys.address, "0xn1"));

  const before = ledger.agents.get(agentId)!.reputation_score;
  const res = await relayer.sync();
  assert.equal(res.anchored, 1);
  assert.equal(res.rejected, 0);
  assert.ok(res.batchRoot);
  assert.ok(ledger.agents.get(agentId)!.reputation_score >= before);
  assert.equal(ledger.externalReceipts.list().length, 1);

  // checkpoint: a second sync with no new events is a no-op (no double anchor)
  const again = await relayer.sync();
  assert.equal(again.anchored, 0);
  assert.equal(ledger.externalReceipts.list().length, 1);
});

test("relayer: reconciles a satellite credit draw + repayment into Casper global exposure", async () => {
  const { ledger, casper, evm, agentId } = setup();
  const relayer = new CasperRootRelayer(evm, casper, new ProofService());
  ledger.exposure.ensure_agent(agentId, 2_000_000_000n);
  const can = ledger.notes.issue_can({
    agent_id: agentId, credit_score: 80, risk_policy_version: 1,
    target_chain: BASE, target_pool: POOL, max_draw: 500_000_000n, asset: "USDC",
  });

  const draw = await evm.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
  assert.equal(draw.ok, true);
  const r1 = await relayer.sync();
  assert.equal(r1.drawsReconciled, 1);
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 300_000_000n);

  await evm.repayCredit({ agent_id: agentId, amount: "300000000" });
  const r2 = await relayer.sync();
  assert.equal(r2.repaymentsReconciled, 1);
  assert.equal(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding, 0n);
});
