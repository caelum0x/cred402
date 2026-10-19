import { test } from "node:test";
import assert from "node:assert/strict";

import { Ledger } from "../lib/ledger/index.js";
import {
  anchorQieCreditScoreSettlement,
  finalizeQieExternalReceipt,
  challengeQieExternalReceipt,
  qieX402Usage,
  type QieAnchorContext,
} from "../api/qie_receipt_anchor.js";

const SELLER = "cred402-seller";
const NETWORK = "eip155:1983"; // QIE testnet
const ASSET = "0x00000000000000000000000000000000000001";
const PAYER = "0x00000000000000000000000000000000000002";
const RECEIVER = "0x00000000000000000000000000000000000003";
const TX = "0x" + "a".repeat(64);

function ctx(): QieAnchorContext {
  return { ledger: new Ledger(), sellerAgentId: SELLER };
}

test("anchorQieCreditScoreSettlement rejects an incomplete settlement (no payer/transaction/amount) without touching the ledger", () => {
  const c = ctx();
  assert.equal(
    anchorQieCreditScoreSettlement(c, {
      agentId: "agent-1",
      network: NETWORK,
      networkName: "testnet",
      assetAddress: ASSET,
      amountBaseUnits: "10000",
      receiver: RECEIVER,
      report: { ok: true },
    }),
    null,
  );
  assert.equal(c.ledger.externalReceipts.list().length, 0);
});

test("anchorQieCreditScoreSettlement anchors a real settlement as provisional (anchored, not finalized)", () => {
  const c = ctx();
  const result = anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "10000",
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true },
  });
  assert.ok(result);
  const receipt = c.ledger.externalReceipts.get(result!.receipt_id);
  assert.ok(receipt);
  assert.equal(receipt!.status, "anchored");
  assert.equal(receipt!.origin_chain, NETWORK);
  assert.equal(receipt!.payer_agent_id, `qie:${PAYER}`);
  assert.equal(receipt!.seller_agent_id, SELLER);
  assert.equal(receipt!.asset, `qie-erc20:${ASSET}`);
  assert.equal(receipt!.amount, "10000");
  assert.equal(receipt!.settlement_tx_hash, TX);
});

test("anchorQieCreditScoreSettlement is idempotent for the same settled transaction (no double-credit)", () => {
  const c = ctx();
  const first = anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "10000",
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true },
  });
  const second = anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "10000",
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true, replayed: true },
  });
  assert.ok(first);
  assert.ok(second);
  assert.equal(first!.receipt_id, second!.receipt_id);
  assert.equal(c.ledger.externalReceipts.list().length, 1);
});

test("anchorQieCreditScoreSettlement refuses a conflicting replay on the same transaction hash", () => {
  const c = ctx();
  anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "10000",
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true },
  });
  const conflict = anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "99999", // different amount, same tx hash
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true },
  });
  assert.equal(conflict, null);
});

test("finalizeQieExternalReceipt moves a provisional anchor to finalized, and only finalized receipts count toward usage", () => {
  const c = ctx();
  const anchored = anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "10000",
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true },
  })!;

  let usage = qieX402Usage(c, NETWORK, ASSET);
  assert.equal(usage.paid_requests, 0, "provisional (anchored, not finalized) receipts must not count yet");

  finalizeQieExternalReceipt(c, anchored.receipt_id);
  assert.equal(c.ledger.externalReceipts.get(anchored.receipt_id)!.status, "finalized");

  usage = qieX402Usage(c, NETWORK, ASSET);
  assert.equal(usage.paid_requests, 1);
  assert.equal(usage.unique_payers, 1);
  assert.equal(usage.total_base_units, "10000");
  assert.equal(usage.latest_receipts[0]!.receipt_id, anchored.receipt_id);
});

test("challengeQieExternalReceipt marks a finality mismatch, excluding it from usage even after finalize", () => {
  const c = ctx();
  const anchored = anchorQieCreditScoreSettlement(c, {
    agentId: "agent-1",
    network: NETWORK,
    networkName: "testnet",
    assetAddress: ASSET,
    amountBaseUnits: "10000",
    payer: PAYER,
    receiver: RECEIVER,
    transaction: TX,
    report: { ok: true },
  })!;

  challengeQieExternalReceipt(c, anchored.receipt_id);
  assert.equal(c.ledger.externalReceipts.get(anchored.receipt_id)!.status, "challenged");

  const usage = qieX402Usage(c, NETWORK, ASSET);
  assert.equal(usage.paid_requests, 0);
});
