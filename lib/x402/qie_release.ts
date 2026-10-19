import { createHash } from "node:crypto";
import { QIE_X402_STATUS_ROUTE, type QieX402PublicStatus } from "./qie_gateway.js";
import type { QieChallengeInspection } from "./qie_client.js";
import type { QieAccountReadiness } from "./qie_readiness.js";

/**
 * Signed (hash-sealed) release evidence for QIE x402 — the same role
 * `algorand_release.ts` plays for Algorand, reused by
 * `scripts/qie_x402_release_check.ts`. "Signed" here means the same thing it
 * means for the Algorand artifact: a SHA-256 digest over the full evidence
 * object, computed and verified with `verifyQieReleaseEvidenceDigest` — there
 * is no private key or external signer involved, and this module does not
 * invent one. Unlike the Algorand artifact, there is no `discovery.bazaar`
 * field: QIE has no confirmed Bazaar-style discovery catalog (tracked as a
 * known gap in `docs/qie_x402.md`), so this module does not claim one.
 */

export interface QieReleaseEvidenceAccount {
  role: "payer" | "receiver";
  address: string;
  ready: boolean;
  chain_id: string;
  block_number: string;
  token_balance_base_units: string;
  checks: Array<{
    id: string;
    result: "pass" | "warn";
    required: boolean;
    message: string;
  }>;
}

export interface QieReleaseEvidence {
  schema_version: "cred402.qie-x402-release-evidence.v1";
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
    network_name: QieChallengeInspection["networkName"];
    network: string;
    asset: string;
    amount_base_units: string;
    pay_to: string;
  };
  accounts: {
    payer: QieReleaseEvidenceAccount;
    receiver: QieReleaseEvidenceAccount;
  };
  evidence_sha256: string;
}

export function qieDeploymentStatusUrl(endpoint: string): string {
  return new URL(QIE_X402_STATUS_ROUTE, endpoint).href;
}

export function assertQieDeploymentStatus(
  status: QieX402PublicStatus,
  challenge: QieChallengeInspection,
): void {
  if (!status.configured) throw new Error(`Deployment is not configured: ${status.reason ?? "unknown reason"}`);
  if (status.protocol !== "x402-v2") throw new Error(`Unexpected deployment protocol: ${status.protocol}`);
  if (status.network !== challenge.selected.network) throw new Error("Status/challenge network mismatch");
  if ((status.asset_address ?? "").toLowerCase() !== challenge.selected.asset.toLowerCase()) {
    throw new Error("Status/challenge asset mismatch");
  }
  if (status.price_base_units !== challenge.selected.amount) throw new Error("Status/challenge price mismatch");
  if ((status.pay_to ?? "").toLowerCase() !== challenge.selected.payTo.toLowerCase()) {
    throw new Error("Status/challenge receiver mismatch");
  }
}

function accountEvidence(readiness: QieAccountReadiness): QieReleaseEvidenceAccount {
  if (!readiness.ready) {
    throw new Error(`${readiness.role} account is not ready; refusing to create passing release evidence`);
  }
  return {
    role: readiness.role,
    address: readiness.snapshot.address,
    ready: readiness.ready,
    chain_id: readiness.snapshot.chainId,
    block_number: readiness.snapshot.blockNumber.toString(),
    token_balance_base_units: readiness.snapshot.tokenBalanceBaseUnits.toString(),
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
export function buildQieReleaseEvidence(input: {
  generatedAt: Date;
  endpoint: string;
  status: QieX402PublicStatus;
  challenge: QieChallengeInspection;
  payerReadiness: QieAccountReadiness;
  receiverReadiness: QieAccountReadiness;
  releaseRef?: string;
}): QieReleaseEvidence {
  if (!Number.isFinite(input.generatedAt.getTime())) throw new Error("Release evidence timestamp is invalid");
  assertQieDeploymentStatus(input.status, input.challenge);
  if (input.payerReadiness.role !== "payer" || input.receiverReadiness.role !== "receiver") {
    throw new Error("Release evidence account roles are invalid");
  }
  if (
    input.payerReadiness.snapshot.address.toLowerCase() === input.receiverReadiness.snapshot.address.toLowerCase() &&
    input.challenge.networkName === "mainnet"
  ) {
    throw new Error("Mainnet release evidence requires an external payer");
  }

  const base = {
    schema_version: "cred402.qie-x402-release-evidence.v1" as const,
    generated_at: input.generatedAt.toISOString(),
    result: "passed" as const,
    mode: "read-only" as const,
    ...(input.releaseRef ? { release_ref: input.releaseRef } : {}),
    resource: {
      url: input.challenge.resourceUrl,
      status_url: qieDeploymentStatusUrl(input.endpoint),
      protocol: "x402-v2" as const,
    },
    payment: {
      network_name: input.challenge.networkName,
      network: input.challenge.selected.network,
      asset: input.challenge.selected.asset,
      amount_base_units: input.challenge.amountBaseUnits,
      pay_to: input.challenge.selected.payTo,
    },
    accounts: {
      payer: accountEvidence(input.payerReadiness),
      receiver: accountEvidence(input.receiverReadiness),
    },
  };
  const evidenceSha256 = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return { ...base, evidence_sha256: evidenceSha256 };
}

export function verifyQieReleaseEvidenceDigest(evidence: QieReleaseEvidence): boolean {
  const { evidence_sha256, ...base } = evidence;
  const expected = createHash("sha256").update(JSON.stringify(base)).digest("hex");
  return evidence_sha256 === expected;
}
