import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  isValidAlgorandAddress,
} from "@x402/avm";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";
import { X402_CHALLENGE_TAG } from "./challenge_tag.js";

export type AlgorandClientNetwork = "testnet" | "mainnet";

export interface AlgorandPaymentPolicy {
  networkName: AlgorandClientNetwork;
  expectedPayTo: string;
  expectedAmountMicroUsdc?: string;
  maxAmountMicroUsdc: string;
  /** URL that was requested. The advertised resource must resolve to the same URL. */
  requestUrl: string;
}

export interface AlgorandChallengeInspection {
  paymentRequired: PaymentRequired;
  selected: PaymentRequirements;
  networkName: AlgorandClientNetwork;
  amountMicroUsdc: string;
  amountUsdc: string;
  resourceUrl: string;
}

export function networkIdFor(name: AlgorandClientNetwork) {
  return name === "mainnet" ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2;
}

export function usdcAssetFor(name: AlgorandClientNetwork) {
  return name === "mainnet" ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID;
}

export function formatMicroUsdc(amount: string): string {
  if (!/^\d+$/.test(amount)) throw new Error("USDC amount must be an unsigned integer");
  const padded = amount.padStart(7, "0");
  const whole = padded.slice(0, -6).replace(/^0+(?=\d)/, "");
  const fraction = padded.slice(-6).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function parsePositiveInteger(name: string, value: string): bigint {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${name} must be a positive integer`);
  }
  return BigInt(value);
}

export function assertSafeAlgorandEndpoint(url: string, networkName: AlgorandClientNetwork): URL {
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
    throw new Error("Algorand Mainnet payments require an HTTPS endpoint");
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
 * This is deliberately reusable as the x402 client's requirements selector so
 * a changed second challenge cannot bypass the preflight checks.
 */
export function selectSafeAlgorandAcceptance(
  x402Version: number,
  accepts: PaymentRequirements[],
  policy: Omit<AlgorandPaymentPolicy, "requestUrl">,
): PaymentRequirements {
  if (x402Version !== 2) throw new Error(`Expected x402 v2, received v${x402Version}`);
  if (!isValidAlgorandAddress(policy.expectedPayTo)) {
    throw new Error("Expected pay-to address is not a valid Algorand address");
  }
  if (accepts.length !== 1) {
    throw new Error(`Expected exactly one payment option, received ${accepts.length}`);
  }

  const selected = accepts[0]!;
  const expectedNetwork = networkIdFor(policy.networkName);
  const expectedAsset = usdcAssetFor(policy.networkName);
  const amount = parsePositiveInteger("Challenge amount", selected.amount);
  const maxAmount = parsePositiveInteger("Maximum amount", policy.maxAmountMicroUsdc);

  if (selected.scheme !== "exact") throw new Error(`Expected exact scheme, received ${selected.scheme}`);
  if (selected.network !== expectedNetwork) throw new Error(`Unexpected network: ${selected.network}`);
  if (selected.asset !== expectedAsset) throw new Error(`Unexpected USDC asset: ${selected.asset}`);
  if (selected.payTo !== policy.expectedPayTo) throw new Error(`Unexpected pay-to address: ${selected.payTo}`);
  if (
    !Number.isSafeInteger(selected.maxTimeoutSeconds) ||
    selected.maxTimeoutSeconds <= 0 ||
    selected.maxTimeoutSeconds > 300
  ) {
    throw new Error(`Unsafe payment timeout: ${selected.maxTimeoutSeconds} seconds`);
  }
  if (amount > maxAmount) {
    throw new Error(`Challenge amount ${selected.amount} exceeds maximum ${policy.maxAmountMicroUsdc} micro-USDC`);
  }
  if (policy.expectedAmountMicroUsdc !== undefined) {
    const expected = parsePositiveInteger("Expected amount", policy.expectedAmountMicroUsdc);
    if (amount !== expected) {
      throw new Error(`Unexpected amount: ${selected.amount} micro-USDC (expected ${expected})`);
    }
  }
  return selected;
}

export function inspectAlgorandChallenge(
  paymentRequired: PaymentRequired,
  policy: AlgorandPaymentPolicy,
): AlgorandChallengeInspection {
  const requestedUrl = assertSafeAlgorandEndpoint(policy.requestUrl, policy.networkName);
  const selected = selectSafeAlgorandAcceptance(paymentRequired.x402Version, paymentRequired.accepts, policy);

  if (!paymentRequired.resource?.url) throw new Error("Challenge is missing its resource URL");
  assertSafeAlgorandEndpoint(paymentRequired.resource.url, policy.networkName);
  if (!sameResourceUrl(paymentRequired.resource.url, requestedUrl.href)) {
    throw new Error(`Challenge resource URL does not match the requested endpoint: ${paymentRequired.resource.url}`);
  }
  if (!paymentRequired.resource.tags?.includes(X402_CHALLENGE_TAG)) {
    throw new Error(`Challenge is missing the ${X402_CHALLENGE_TAG} resource tag`);
  }
  // Attribution is written from the accepted payment option's `extra.tag` at settlement
  // time and is never backfilled, so a missing tag silently files this sale under
  // `direct` instead of the Global x402 Challenge. Treat it as a release blocker.
  const acceptedTag = (selected.extra as Record<string, unknown> | null | undefined)?.tag;
  if (acceptedTag !== X402_CHALLENGE_TAG) {
    throw new Error(
      `Accepted payment option is missing extra.tag=${X402_CHALLENGE_TAG} (received ${String(acceptedTag)}); settled volume would not be attributed to the challenge`,
    );
  }

  const bazaar = paymentRequired.extensions?.bazaar;
  if (!bazaar || typeof bazaar !== "object" || Array.isArray(bazaar)) {
    throw new Error("Challenge is missing Bazaar discovery metadata");
  }
  const validation = validateDiscoveryExtensionSpec(bazaar as Record<string, unknown>);
  if (!validation.valid) {
    throw new Error(`Invalid Bazaar discovery metadata: ${validation.errors?.join("; ") ?? "unknown error"}`);
  }

  return {
    paymentRequired,
    selected,
    networkName: policy.networkName,
    amountMicroUsdc: selected.amount,
    amountUsdc: formatMicroUsdc(selected.amount),
    resourceUrl: paymentRequired.resource.url,
  };
}

export async function readAndInspectAlgorandChallenge(
  response: Response,
  policy: AlgorandPaymentPolicy,
): Promise<AlgorandChallengeInspection> {
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
  return inspectAlgorandChallenge(paymentRequired, policy);
}

export function paymentConfirmationPhrase(inspection: AlgorandChallengeInspection): string {
  return [
    "PAY",
    inspection.amountUsdc,
    "USDC",
    "ON",
    "ALGORAND",
    inspection.networkName.toUpperCase(),
    "TO",
    inspection.selected.payTo,
  ].join(" ");
}
