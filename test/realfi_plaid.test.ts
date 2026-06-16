import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../lib/ledger/ledger.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import { bankVerificationFromPlaid, plaidFromEnv } from "../lib/realfi/plaid.js";

/**
 * p10 — real Plaid sandbox integration. The live calls hit Plaid sandbox (gated
 * by PLAID_CLIENT_ID/PLAID_SECRET); the response → envelope mapping is pure and
 * tested here offline, then committed through the real RealFi Bridge so a Bank
 * Verification Envelope lands on-chain (hashes only).
 */

test("p10 plaid: maps a sandbox auth+balance response to a verified bank envelope", () => {
  const input = bankVerificationFromPlaid(
    "operator:0xabc",
    { accounts: [{ account_id: "acc_1" }], numbers: { ach: [{ account: "1111" }] } },
    { accounts: [{ balances: { current: 4210.55 } }] },
    1_700_000_000,
  );
  assert.equal(input.account_ownership_verified, true, "account + ACH present → ownership verified");
  assert.equal(input.data_period_end, 1_700_000_000);
  assert.equal(input.data_period_start, 1_700_000_000 - 30 * 24 * 60 * 60);

  // Commit it through the real bridge → on-chain attestation (hashes only).
  const bridge = new RealFiBridge(new Ledger());
  const { attestation_hash, envelope } = bridge.recordBankVerification(input);
  assert.match(attestation_hash, /^0x[0-9a-f]+$/);
  assert.equal(envelope.account_ownership_verified, true);
  // Raw report is hashed, never stored.
  assert.ok(!("cashflow_report" in envelope), "no raw cashflow on the envelope");
});

test("p10 plaid: missing ACH numbers → ownership not verified", () => {
  const input = bankVerificationFromPlaid(
    "operator:0xdef",
    { accounts: [{ account_id: "acc_2" }], numbers: { ach: [] } },
    { accounts: [{ balances: { current: 10 } }] },
  );
  assert.equal(input.account_ownership_verified, false);
});

test("p10 plaid: connector is null unless sandbox creds are configured", () => {
  assert.equal(plaidFromEnv({}), null);
  assert.ok(plaidFromEnv({ PLAID_CLIENT_ID: "x", PLAID_SECRET: "y" }));
});
