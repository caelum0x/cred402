import { test } from "node:test";
import assert from "node:assert/strict";
import { ReceiptProofSystem, merkleRoot, rootFromPath, merklePath } from "../lib/services/receipt_proof.js";

/**
 * Roadmap p8 — receipt proofs (trust-ladder Stage 4). Prove a receipt is anchored
 * and disclose only chosen fields, hiding the rest, with on-chain-verifiable
 * Merkle inclusion.
 */

const RECEIPTS = [
  { receipt_id: "r1", attrs: { amount: "100", service_category: "rwa", finalized: "true", counterparty: "buyerA" } },
  { receipt_id: "r2", attrs: { amount: "250", service_category: "inference", finalized: "true", counterparty: "buyerB" } },
  { receipt_id: "r3", attrs: { amount: "40", service_category: "data", finalized: "false", counterparty: "buyerC" } },
];

test("p8: a valid selective-disclosure proof verifies against the anchored root", () => {
  const sys = new ReceiptProofSystem("prover-secret");
  const { root } = sys.publishRoot(RECEIPTS);
  // disclose only category + finalized for r1; hide amount + counterparty
  const proof = sys.prove(RECEIPTS, 0, ["service_category", "finalized"]);
  const result = ReceiptProofSystem.verify(proof, root);
  assert.equal(result.valid, true, result.reason);
  assert.deepEqual(result.disclosed, { service_category: "rwa", finalized: "true" });
  // hidden fields are NOT present in the proof or the result
  assert.ok(!("amount" in result.disclosed));
  assert.ok(!JSON.stringify(proof.hidden_commitments).includes("100"), "hidden value never appears in the clear");
  assert.ok(!("counterparty" in proof.disclosed));
});

test("p8: tampering with a disclosed value breaks verification", () => {
  const sys = new ReceiptProofSystem("prover-secret");
  const { root } = sys.publishRoot(RECEIPTS);
  const proof = sys.prove(RECEIPTS, 1, ["amount"]);
  // attacker claims the amount was 9999 with the same salt
  const forged = { ...proof, disclosed: { amount: { value: "9999", salt: proof.disclosed.amount!.salt } } };
  const result = ReceiptProofSystem.verify(forged, root);
  assert.equal(result.valid, false);
  assert.match(result.reason!, /reconstruct/);
});

test("p8: a proof for one batch fails against a different root", () => {
  const sys = new ReceiptProofSystem("prover-secret");
  sys.publishRoot(RECEIPTS);
  const proof = sys.prove(RECEIPTS, 2, ["service_category"]);
  const otherRoot = sys.publishRoot([RECEIPTS[0]!]).root;
  const result = ReceiptProofSystem.verify(proof, otherRoot);
  assert.equal(result.valid, false);
  assert.match(result.reason!, /anchored root/);
});

test("p8: the prover secret hides field values (different secret => different commitments)", () => {
  const a = new ReceiptProofSystem("secret-A").commit("r1", { amount: "100" });
  const b = new ReceiptProofSystem("secret-B").commit("r1", { amount: "100" });
  assert.notEqual(a.commitments.amount, b.commitments.amount, "salt depends on the prover secret");
  assert.notEqual(a.leaf, b.leaf);
});

test("p8: Merkle path reconstructs the root for every leaf (incl. odd batch tail)", () => {
  const sys = new ReceiptProofSystem("prover-secret");
  const { root, commitments } = sys.publishRoot(RECEIPTS); // 3 = odd, exercises tail duplication
  const leaves = commitments.map((c) => c.leaf);
  for (let i = 0; i < leaves.length; i++) {
    assert.equal(rootFromPath(leaves[i]!, merklePath(leaves, i)), root, `leaf ${i} reconstructs root`);
  }
  assert.equal(merkleRoot(leaves), root);
});

test("p8: disclosing all fields still verifies (full reveal is a special case)", () => {
  const sys = new ReceiptProofSystem("prover-secret");
  const { root } = sys.publishRoot(RECEIPTS);
  const proof = sys.prove(RECEIPTS, 0, ["amount", "service_category", "finalized", "counterparty"]);
  const result = ReceiptProofSystem.verify(proof, root);
  assert.equal(result.valid, true);
  assert.equal(result.disclosed.amount, "100");
  assert.equal(Object.keys(proof.hidden_commitments).length, 0);
});
