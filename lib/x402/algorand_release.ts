import { createHash } from "node:crypto";
import {
  ALGORAND_X402_STATUS_ROUTE,
  type AlgorandX402PublicStatus,
} from "./algorand_gateway.js";
import type { AlgorandChallengeInspection } from "./algorand_client.js";
import type { AlgorandAccountReadiness } from "./algorand_readiness.js";

export interface AlgorandReleaseEvidenceAccount {
  role: "payer" | "receiver";
  address: string;
  ready: boolean;
  valid_as_of_round: string;
  balances: {
    micro_algo: string;
    minimum_micro_algo: string;
    micro_usdc: string;
  };
  checks: Array<{
    id: string;
    result: "pass" | "warn";
    required: boolean;
    message: string;
  }>;
}

export interface AlgorandReleaseEvidence {
  schema_version: "cred402.algorand-x402-release-evidence.v1";
  generated_at: string;
  result: "passed";
  mode: "read-only";
  release_ref?: string;
  resource: {
    url: string;
    status_url: string;
    protocol: "x402-v2";
  };
  payment: {
    network_name: AlgorandChallengeInspection["networkName"];
    network: string;
    asset: string;
    amount_micro_usdc: string;
    amount_usdc: string;
    pay_to: string;
  };
  discovery: {
    bazaar: true;
    challenge_tag: "x402-global-challenge";
  };
  accounts: {
    payer: AlgorandReleaseEvidenceAccount;
    receiver: AlgorandReleaseEvidenceAccount;
  };
  evidence_sha256: string;
}

export function algorandDeploymentStatusUrl(endpoint: string): string {
  return new URL(ALGORAND_X402_STATUS_ROUTE, endpoint).href;
}

export function assertAlgorandDeploymentStatus(
  status: AlgorandX402PublicStatus,
  challenge: AlgorandChallengeInspection,
): void {
  if (!status.configured) throw new Error(`Deployment is not configured: ${status.reason ?? "unknown reason"}`);
  if (status.protocol !== "x402-v2") throw new Error(`Unexpected deployment protocol: ${status.protocol}`);
  if (status.network !== challenge.selected.network) throw new Error("Status/challenge network mismatch");
  if (status.usdc_asset !== challenge.selected.asset) throw new Error("Status/challenge asset mismatch");
  if (status.price_micro_usdc !== challenge.selected.amount) throw new Error("Status/challenge price mismatch");
  if (status.pay_to !== challenge.selected.payTo) throw new Error("Status/challenge receiver mismatch");
  if (
    !status.discovery ||
    !status.discovery.bazaar ||
    status.discovery.challenge_tag !== "x402-global-challenge"
  ) {
    throw new Error("Deployment status is missing required discovery declarations");
  }
}

function accountEvidence(readiness: AlgorandAccountReadiness): AlgorandReleaseEvidenceAccount {
  if (!readiness.ready) {
    throw new Error(`${readiness.role} account is not ready; refusing to create passing release evidence`);
  }
  return {
    role: readiness.role,
    address: readiness.snapshot.address,
    ready: readiness.ready,
    valid_as_of_round: readiness.snapshot.validAsOfRound.toString(),
    balances: {
      micro_algo: readiness.snapshot.balanceMicroAlgo.toString(),
      minimum_micro_algo: readiness.snapshot.minimumBalanceMicroAlgo.toString(),
      micro_usdc: readiness.snapshot.usdcBalanceMicro.toString(),
    },
    checks: readiness.checks.map((check) => ({
      id: check.id,
      result: check.ok ? "pass" : "warn",
      required: check.required,
      message: check.message,
    })),
  };
}

/**
 * Build a secret-free, tamper-evident record of a passing public release gate.
 * The digest covers every field above it in the stable object order emitted here.
 */
export function buildAlgorandReleaseEvidence(input: {
  generatedAt: Date;
  endpoint: string;
  status: AlgorandX402PublicStatus;
  challenge: AlgorandChallengeInspection;
  payerReadiness: AlgorandAccountReadiness;
  receiverReadiness: AlgorandAccountReadiness;
  releaseRef?: string;
}): AlgorandReleaseEvidence {
  if (!Number.isFinite(input.generatedAt.getTime())) throw new Error("Release evidence timestamp is invalid");
  assertAlgorandDeploymentStatus(input.status, input.challenge);
  if (input.payerReadiness.role !== "payer" || input.receiverReadiness.role !== "receiver") {
    throw new Error("Release evidence account roles are invalid");
  }
  if (input.payerReadiness.snapshot.address === input.receiverReadiness.snapshot.address &&
      input.challenge.networkName === "mainnet") {
    throw new Error("Mainnet release evidence requires an external payer");
  }

  const base = {
    schema_version: "cred402.algorand-x402-release-evidence.v1" as const,
    generated_at: input.generatedAt.toISOString(),
    result: "passed" as const,
    mode: "read-only" as const,
    ...(input.releaseRef ? { release_ref: input.releaseRef } : {}),
    resource: {
      url: input.challenge.resourceUrl,
      status_url: algorandDeploymentStatusUrl(input.endpoint),
      protocol: "x402-v2" as const,
    },
    payment: {
      network_name: input.challenge.networkName,
      network: input.challenge.selected.network,
      asset: input.challenge.selected.asset,
      amount_micro_usdc: input.challenge.amountMicroUsdc,
      amount_usdc: input.challenge.amountUsdc,
      pay_to: input.challenge.selected.payTo,
    },
    discovery: {
      bazaar: true as const,
      challenge_tag: "x402-global-challenge" as const,
    },
    accounts: {
      payer: accountEvidence(input.payerReadiness),
      receiver: accountEvidence(input.receiverReadiness),
    },
  };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { ...base, evidence_sha256: evidenceSha256 };
}

export function verifyAlgorandReleaseEvidenceDigest(evidence: AlgorandReleaseEvidence): boolean {
  const { evidence_sha256, ...base } = evidence;
  const expected = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return evidence_sha256 === expected;
}
