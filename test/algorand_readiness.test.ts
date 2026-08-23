import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessAlgorandAccountReadiness,
  assertExternalMainnetPayer,
  formatMicroAlgo,
  type AlgorandAccountSnapshot,
} from "../lib/x402/algorand_readiness.js";

const ADDRESS = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";

function snapshot(
  overrides: Partial<AlgorandAccountSnapshot> = {},
): AlgorandAccountSnapshot {
  return {
    address: ADDRESS,
    balanceMicroAlgo: 202_000n,
    minimumBalanceMicroAlgo: 200_000n,
    validAsOfRound: 55_000_000n,
    usdcOptedIn: true,
    usdcFrozen: false,
    usdcBalanceMicro: 25_000n,
    ...overrides,
  };
}

test("payer is ready with minimum balance, opted-in USDC, and enough funds", () => {
  const result = assessAlgorandAccountReadiness(snapshot(), "payer", 10_000n);
  assert.equal(result.ready, true);
  assert.equal(result.checks.find((check) => check.id === "usdc_balance")?.ok, true);
  assert.equal(result.checks.find((check) => check.id === "fee_buffer")?.ok, true);
});

test("fee-buffer warning is advisory but insufficient USDC blocks the payer", () => {
  const warningOnly = assessAlgorandAccountReadiness(
    snapshot({ balanceMicroAlgo: 200_000n }),
    "payer",
    10_000n,
  );
  assert.equal(warningOnly.checks.find((check) => check.id === "fee_buffer")?.ok, false);
  assert.equal(warningOnly.ready, true);

  const insufficient = assessAlgorandAccountReadiness(
    snapshot({ usdcBalanceMicro: 9_999n }),
    "payer",
    10_000n,
  );
  assert.equal(insufficient.ready, false);
  assert.equal(insufficient.checks.find((check) => check.id === "usdc_balance")?.ok, false);
});

test("receiver must meet minimum balance and hold an unfrozen USDC opt-in", () => {
  const missingOptIn = assessAlgorandAccountReadiness(
    snapshot({ usdcOptedIn: false, usdcBalanceMicro: 0n }),
    "receiver",
    10_000n,
  );
  assert.equal(missingOptIn.ready, false);
  assert.equal(missingOptIn.checks.some((check) => check.id === "usdc_balance"), false);

  const frozen = assessAlgorandAccountReadiness(
    snapshot({ usdcFrozen: true }),
    "receiver",
    10_000n,
  );
  assert.equal(frozen.ready, false);

  const belowMinimum = assessAlgorandAccountReadiness(
    snapshot({ balanceMicroAlgo: 199_999n }),
    "receiver",
    10_000n,
  );
  assert.equal(belowMinimum.ready, false);
});

test("ALGO formatting preserves atomic precision", () => {
  assert.equal(formatMicroAlgo(1_000n), "0.001");
  assert.equal(formatMicroAlgo(1_234_567n), "1.234567");
  assert.equal(formatMicroAlgo(-1_000n), "-0.001");
});

test("Mainnet activation rejects self-payment while Testnet permits a technical loop", () => {
  assert.doesNotThrow(() => assertExternalMainnetPayer("testnet", ADDRESS, ADDRESS));
  assert.throws(
    () => assertExternalMainnetPayer("mainnet", ADDRESS, ADDRESS),
    /self-payment is not a valid activation test/,
  );
  assert.doesNotThrow(() =>
    assertExternalMainnetPayer(
      "mainnet",
      ADDRESS,
      "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    ),
  );
});
