import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { qieNetworkIdFor, type QieNetworkName } from "./qie_networks.js";

/**
 * Offline, payment-free inspection of a QIE x402 challenge — the same role
 * `algorand_client.ts` plays for Algorand, reused for the preflight check
 * script (`scripts/qie_x402_check.ts`). Pure decoding + policy checks; never
 * signs or submits a transaction.
 */

export interface QiePaymentPolicy {
  networkName: QieNetworkName;
  expectedPayTo: string;
  expectedAssetAddress: string;
  expectedAmountBaseUnits?: string;
  maxAmountBaseUnits: string;
  /** URL that was requested. The advertised resource must resolve to the same URL. */
  requestUrl: string;
}

export interface QieChallengeInspection {
  paymentRequired: PaymentRequired;
  selected: PaymentRequirements;
  networkName: QieNetworkName;
  amountBaseUnits: string;
  resourceUrl: string;
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

function parsePositiveInteger(name: string, value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(value);
}

export function assertSafeQieEndpoint(url: string, networkName: QieNetworkName): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Endpoint must be a valid absolute URL");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error("Endpoint must be an HTTP(S) URL without embedded credentials");
  }
  if (networkName === "mainnet" && parsed.protocol !== "https:") {
    throw new Error("QIE Mainnet payments require an HTTPS endpoint");
  }
  return parsed;
}

function sameResourceUrl(advertised: string, requested: string): boolean {
  const advertisedUrl = new URL(advertised);
  const requestedUrl = new URL(requested);
  advertisedUrl.hash = "";
  requestedUrl.hash = "";
  return advertisedUrl.href === requestedUrl.href;
}

/**
 * Select the only payment acceptance after enforcing all economic constraints.
 * Deliberately reusable as the x402 client's requirements selector so a
 * changed second challenge cannot bypass the preflight checks.
 */
export function selectSafeQieAcceptance(
  x402Version: number,
  accepts: PaymentRequirements[],
  policy: Omit<QiePaymentPolicy, "requestUrl">,
): PaymentRequirements {
  if (x402Version !== 2) throw new Error(`Expected x402 v2, received v${x402Version}`);
  if (!isEvmAddress(policy.expectedPayTo)) throw new Error("Expected pay-to address is not a valid EVM address");
  if (!isEvmAddress(policy.expectedAssetAddress)) throw new Error("Expected asset address is not a valid EVM address");
  if (accepts.length !== 1) throw new Error(`Expected exactly one payment option, received ${accepts.length}`);

  const selected = accepts[0]!;
  const expectedNetwork = qieNetworkIdFor(policy.networkName);
  const amount = parsePositiveInteger("Challenge amount", selected.amount);
  const maxAmount = parsePositiveInteger("Maximum amount", policy.maxAmountBaseUnits);

  if (selected.scheme !== "exact") throw new Error(`Expected exact scheme, received ${selected.scheme}`);
  if (selected.network !== expectedNetwork) throw new Error(`Unexpected network: ${selected.network}`);
  if (selected.asset.toLowerCase() !== policy.expectedAssetAddress.toLowerCase()) {
    throw new Error(`Unexpected asset contract: ${selected.asset}`);
  }
  if (selected.payTo.toLowerCase() !== policy.expectedPayTo.toLowerCase()) {
    throw new Error(`Unexpected pay-to address: ${selected.payTo}`);
  }
  if (!Number.isSafeInteger(selected.maxTimeoutSeconds) || selected.maxTimeoutSeconds <= 0 || selected.maxTimeoutSeconds > 300) {
    throw new Error(`Unsafe payment timeout: ${selected.maxTimeoutSeconds} seconds`);
  }
  if (amount > maxAmount) {
    throw new Error(`Challenge amount ${selected.amount} exceeds maximum ${policy.maxAmountBaseUnits} base units`);
  }
  if (policy.expectedAmountBaseUnits !== undefined) {
    const expected = parsePositiveInteger("Expected amount", policy.expectedAmountBaseUnits);
    if (amount !== expected) {
      throw new Error(`Unexpected amount: ${selected.amount} base units (expected ${expected})`);
    }
  }
  return selected;
}

export function inspectQieChallenge(
  paymentRequired: PaymentRequired,
  policy: QiePaymentPolicy,
): QieChallengeInspection {
  const requestedUrl = assertSafeQieEndpoint(policy.requestUrl, policy.networkName);
  const selected = selectSafeQieAcceptance(paymentRequired.x402Version, paymentRequired.accepts, policy);

  if (!paymentRequired.resource?.url) throw new Error("Challenge is missing its resource URL");
  assertSafeQieEndpoint(paymentRequired.resource.url, policy.networkName);
  if (!sameResourceUrl(paymentRequired.resource.url, requestedUrl.href)) {
    throw new Error(`Challenge resource URL does not match the requested endpoint: ${paymentRequired.resource.url}`);
  }

  return {
    paymentRequired,
    selected,
    networkName: policy.networkName,
    amountBaseUnits: selected.amount,
    resourceUrl: paymentRequired.resource.url,
  };
}

export async function readAndInspectQieChallenge(
  response: Response,
  policy: QiePaymentPolicy,
): Promise<QieChallengeInspection> {
  if (response.status !== 402) {
    throw new Error(`Expected HTTP 402 Payment Required, received ${response.status}`);
  }
  const encoded = response.headers.get("PAYMENT-REQUIRED");
  if (!encoded) throw new Error("HTTP 402 response is missing the PAYMENT-REQUIRED header");

  let paymentRequired: PaymentRequired;
  try {
    paymentRequired = decodePaymentRequiredHeader(encoded);
  } catch (error) {
    throw new Error(`Could not decode PAYMENT-REQUIRED: ${error instanceof Error ? error.message : String(error)}`);
  }
  return inspectQieChallenge(paymentRequired, policy);
}
