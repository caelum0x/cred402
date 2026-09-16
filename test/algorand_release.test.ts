import { test } from "node:test";
import assert from "node:assert/strict";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { USDC_MAINNET_ASA_ID } from "@x402/avm";
import { ALGORAND_MAINNET_NETWORK } from "../lib/x402/algorand_networks.js";
import type { AlgorandX402PublicStatus } from "../lib/x402/algorand_gateway.js";
import type { AlgorandChallengeInspection } from "../lib/x402/algorand_client.js";
import {
  buildAlgorandReleaseEvidence,
  verifyAlgorandReleaseEvidenceDigest,
} from "../lib/x402/algorand_release.js";
import {
  assessAlgorandAccountReadiness,
  type AlgorandAccountSnapshot,
} from "../lib/x402/algorand_readiness.js";

const PAYER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ";
const RECEIVER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const ENDPOINT = "https://cred402.example/v1/x402/credit-score/EvidenceSellerAgent";

function snapshot(address: string): AlgorandAccountSnapshot {
  return {
    address,
    balanceMicroAlgo: 500_000n,
    minimumBalanceMicroAlgo: 200_000n,
    validAsOfRound: 55_000_000n,
    usdcOptedIn: true,
    usdcFrozen: false,
    usdcBalanceMicro: 50_000n,
  };
}

function fixture() {
  const selected: PaymentRequirements = {
    scheme: "exact",
    network: ALGORAND_MAINNET_NETWORK,
    asset: USDC_MAINNET_ASA_ID,
    amount: "10000",
    payTo: RECEIVER,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", decimals: 6 },
  };
  const paymentRequired = {
    x402Version: 2,
    resource: { url: ENDPOINT, description: "Credit score", mimeType: "application/json" },
    accepts: [selected],
  } as PaymentRequired;
  const challenge: AlgorandChallengeInspection = {
    paymentRequired,
    selected,
    networkName: "mainnet",
    amountMicroUsdc: "10000",
    amountUsdc: "0.01",
    resourceUrl: ENDPOINT,
  };
  const status: AlgorandX402PublicStatus = {
    schema_version: "cred402.algorand-x402-status.v1",
    configured: true,
    protocol: "x402-v2",
    paid_route: "/v1/x402/credit-score/:agentId",
    network: ALGORAND_MAINNET_NETWORK,
    network_name: "mainnet",
    usdc_asset: USDC_MAINNET_ASA_ID,
    price_micro_usdc: "10000",
    pay_to: RECEIVER,
    facilitator_url: "https://facilitator.example",
    public_origin: "https://cred402.example",
    discovery: { bazaar: true, challenge_tag: "x402-global-challenge" },
  };
  return { challenge, status };
}

test("release evidence is secret-free, serializable, and integrity checked", () => {
  const { challenge, status } = fixture();
  const evidence = buildAlgorandReleaseEvidence({
    generatedAt: new Date("2026-08-23T12:00:00.000Z"),
    endpoint: ENDPOINT,
    status,
    challenge,
    payerReadiness: assessAlgorandAccountReadiness(snapshot(PAYER), "payer", 10_000n),
    receiverReadiness: assessAlgorandAccountReadiness(snapshot(RECEIVER), "receiver", 10_000n),
    releaseRef: "abc123",
  });

  assert.equal(evidence.result, "passed");
  assert.equal(evidence.release_ref, "abc123");
  assert.equal(evidence.accounts.payer.valid_as_of_round, "55000000");
  assert.equal(verifyAlgorandReleaseEvidenceDigest(evidence), true);
  assert.doesNotThrow(() => JSON.stringify(evidence));
  assert.doesNotMatch(JSON.stringify(evidence), /private|mnemonic|secret/i);
  assert.equal(
    verifyAlgorandReleaseEvidenceDigest({ ...evidence, release_ref: "tampered" }),
    false,
  );
});

test("release evidence refuses unready accounts and Mainnet self-payment", () => {
  const { challenge, status } = fixture();
  const receiverReadiness = assessAlgorandAccountReadiness(snapshot(RECEIVER), "receiver", 10_000n);
  assert.throws(
    () => buildAlgorandReleaseEvidence({
      generatedAt: new Date(),
      endpoint: ENDPOINT,
      status,
      challenge,
      payerReadiness: assessAlgorandAccountReadiness(
        snapshot(PAYER),
        "payer",
        60_000n,
      ),
      receiverReadiness,
    }),
    /payer account is not ready/,
  );

  assert.throws(
    () => buildAlgorandReleaseEvidence({
      generatedAt: new Date(),
      endpoint: ENDPOINT,
      status,
      challenge,
      payerReadiness: assessAlgorandAccountReadiness(snapshot(RECEIVER), "payer", 10_000n),
      receiverReadiness,
    }),
    /external payer/,
  );
});
