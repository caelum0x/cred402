import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { verifyNearAssetTransfer } from "./near_finality.js";
import {
  DEFAULT_NEAR_RPC_URL,
  NEAR_MAINNET_NETWORK,
  NEAR_TESTNET_NETWORK,
  isValidNearAccountId,
  isValidNearHash,
  nearNetworkNameFor,
  type NearNetworkId,
  type NearNetworkName,
} from "./near_networks.js";

/**
 * NEAR x402 resource server for the NEAR Hackathon (Nov 1-14, 2026).
 *
 * NEAR is neither EVM (`@x402/evm`) nor AVM (`@x402/avm`) compatible, and no
 * `@x402/near` package exists. Rather than bolting NEAR onto a scheme
 * package built for a different VM, this is a small, honest, from-scratch
 * `exact`-scheme implementation that speaks the real x402 v2 wire format —
 * it reuses `@x402/core`'s chain-agnostic header codecs
 * (`encodePaymentRequiredHeader` / `decodePaymentSignatureHeader` /
 * `encodePaymentResponseHeader`) and generic `PaymentRequirements` /
 * `PaymentPayload` types (`Network = \`${string}:${string}\``, so
 * `near:testnet` is a valid network id), but does its own verification.
 *
 * There is deliberately no third-party facilitator. A NEAR account (held
 * directly, or via NEAR Chain Signatures / an MPC-controlled account — see
 * `docs/near_x402.md`) signs and submits a native NEAR `Transfer` action to
 * the configured pay-to account, then presents the resulting transaction
 * hash as proof. Cred402 is its own facilitator: it reads the transaction
 * back from the configured NEAR RPC endpoint directly
 * (`near_finality.ts`) and only settles once the transfer is independently
 * confirmed — the same trust model a self-hosted x402 facilitator would
 * have, with no extra hop.
 */

export const NEAR_CREDIT_SCORE_ROUTE = "/v1/x402/near/credit-score/:agentId";
export const NEAR_X402_STATUS_ROUTE = "/v1/x402/near/status";
export const NEAR_NATIVE_ASSET = "near-native";
export const DEFAULT_NEAR_PRICE_YOCTO = "10000000000000000000000"; // 0.01 NEAR (24 decimals)
export const NEAR_MAINNET_RELEASE_ACK = "I_ACKNOWLEDGE_REAL_NEAR_MAINNET_PAYMENTS";

export interface NearX402Config {
  releaseTier: "development" | "testnet" | "mainnet";
  payTo: string;
  networkName: NearNetworkName;
  network: NearNetworkId;
  rpcUrl: string;
  rpcTimeoutMs: number;
  minimumFinalityBlocks: number;
  priceYocto: string;
  publicBaseUrl?: string;
}

export type NearX402ConfigResult =
  | { enabled: true; config: NearX402Config }
  | { enabled: false; reason: string };

export interface NearX402PublicStatus {
  schema_version: "cred402.near-x402-status.v1";
  configured: boolean;
  protocol: "x402-v2";
  paid_route: typeof NEAR_CREDIT_SCORE_ROUTE;
  facilitator: "self-verified";
  network?: NearX402Config["network"];
  network_name?: NearNetworkName;
  asset?: typeof NEAR_NATIVE_ASSET;
  price_yocto?: string;
  pay_to?: string;
  rpc_url?: string;
  public_origin?: string;
  release_tier?: "development" | "testnet" | "mainnet";
  finality?: {
    rpc_url: string;
    minimum_finality_blocks: number;
  };
  reason?: string;
}

/** Public, secret-free deployment metadata for probes and release automation. */
export function describeNearX402(result: NearX402ConfigResult): NearX402PublicStatus {
  const base = {
    schema_version: "cred402.near-x402-status.v1" as const,
    configured: result.enabled,
    protocol: "x402-v2" as const,
    paid_route: NEAR_CREDIT_SCORE_ROUTE as typeof NEAR_CREDIT_SCORE_ROUTE,
    facilitator: "self-verified" as const,
  };
  if (!result.enabled) return { ...base, reason: result.reason };
  return {
    ...base,
    network: result.config.network,
    network_name: result.config.networkName,
    asset: NEAR_NATIVE_ASSET,
    price_yocto: result.config.priceYocto,
    pay_to: result.config.payTo,
    rpc_url: result.config.rpcUrl,
    public_origin: result.config.publicBaseUrl,
    release_tier: result.config.releaseTier,
    finality: {
      rpc_url: result.config.rpcUrl,
      minimum_finality_blocks: result.config.minimumFinalityBlocks,
    },
  };
}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number | undefined {
  const value = Number(env[key] ?? fallback);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

/**
 * Load the NEAR x402 resource-server configuration. A pay-to account is
 * mandatory: the paid endpoint must never silently become free or advertise
 * a placeholder recipient.
 */
export function loadNearX402Config(env: NodeJS.ProcessEnv = process.env): NearX402ConfigResult {
  const payTo = env.CRED402_NEAR_PAY_TO?.trim();
  if (!payTo) {
    return { enabled: false, reason: "CRED402_NEAR_PAY_TO is required to enable the paid NEAR endpoint" };
  }
  if (!isValidNearAccountId(payTo)) {
    return { enabled: false, reason: "CRED402_NEAR_PAY_TO is not a valid NEAR account id" };
  }

  const rawNetwork = (env.CRED402_NEAR_NETWORK ?? "testnet").trim();
  const networkName = nearNetworkNameFor(rawNetwork);
  if (!networkName) {
    return { enabled: false, reason: "CRED402_NEAR_NETWORK must be testnet or mainnet" };
  }
  const mainnet = networkName === "mainnet";

  const production = env.NODE_ENV === "production";
  const releaseTier = env.CRED402_ENV ?? "development";
  if (!new Set(["development", "testnet", "mainnet"]).has(releaseTier)) {
    return { enabled: false, reason: "CRED402_ENV must be development, testnet, or mainnet" };
  }
  if ((releaseTier === "mainnet") !== mainnet) {
    return { enabled: false, reason: "CRED402_ENV=mainnet and CRED402_NEAR_NETWORK=mainnet must be enabled together" };
  }
  if (mainnet && env.CRED402_NEAR_MAINNET_RELEASE_ACK !== NEAR_MAINNET_RELEASE_ACK) {
    return { enabled: false, reason: `CRED402_NEAR_MAINNET_RELEASE_ACK must equal ${NEAR_MAINNET_RELEASE_ACK}` };
  }
  if ((mainnet || production) && !env.CRED402_DATA_DIR?.trim()) {
    return {
      enabled: false,
      reason: "CRED402_DATA_DIR is required for durable payment replay protection on Mainnet and in production",
    };
  }

  let rpcUrl = env.CRED402_NEAR_RPC_URL?.trim();
  if (!rpcUrl) rpcUrl = DEFAULT_NEAR_RPC_URL[networkName];
  try {
    const parsed = new URL(rpcUrl);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid RPC URL");
    rpcUrl = parsed.href.replace(/\/+$/, "");
  } catch {
    return { enabled: false, reason: "CRED402_NEAR_RPC_URL must be an HTTP(S) URL without embedded credentials" };
  }
  if ((mainnet || production) && !rpcUrl.startsWith("https://")) {
    return { enabled: false, reason: "CRED402_NEAR_RPC_URL must use HTTPS on Mainnet and in production" };
  }

  let publicBaseUrl: string | undefined;
  if (env.CRED402_PUBLIC_URL?.trim()) {
    try {
      const parsed = new URL(env.CRED402_PUBLIC_URL.trim());
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid origin");
      publicBaseUrl = parsed.origin;
    } catch {
      return { enabled: false, reason: "CRED402_PUBLIC_URL must be a valid HTTP(S) origin" };
    }
  }
  if ((mainnet || production) && (!publicBaseUrl || !publicBaseUrl.startsWith("https://"))) {
    return { enabled: false, reason: "CRED402_PUBLIC_URL must be a pinned HTTPS origin on Mainnet and in production" };
  }

  const priceYocto = (env.CRED402_NEAR_PRICE_YOCTO ?? DEFAULT_NEAR_PRICE_YOCTO).trim();
  if (!/^\d+$/.test(priceYocto) || BigInt(priceYocto) <= 0n) {
    return { enabled: false, reason: "CRED402_NEAR_PRICE_YOCTO must be a positive integer" };
  }

  const rpcTimeoutMs = boundedInteger(env, "CRED402_NEAR_RPC_TIMEOUT_MS", 8_000, 250, 30_000);
  if (rpcTimeoutMs === undefined) {
    return { enabled: false, reason: "CRED402_NEAR_RPC_TIMEOUT_MS must be an integer from 250 to 30000" };
  }
  const minimumFinalityBlocks = boundedInteger(env, "CRED402_NEAR_MIN_FINALITY_BLOCKS", 2, 1, 1000);
  if (minimumFinalityBlocks === undefined) {
    return { enabled: false, reason: "CRED402_NEAR_MIN_FINALITY_BLOCKS must be an integer from 1 to 1000" };
  }

  return {
    enabled: true,
    config: {
      releaseTier: releaseTier as "development" | "testnet" | "mainnet",
      payTo,
      networkName,
      network: mainnet ? NEAR_MAINNET_NETWORK : NEAR_TESTNET_NETWORK,
      rpcUrl,
      rpcTimeoutMs,
      minimumFinalityBlocks,
      priceYocto,
      publicBaseUrl,
    },
  };
}

/** Prevent a CDN or browser cache from turning one paid response into a free one. */
export function nearX402PrivateResponseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "PAYMENT-SIGNATURE, Accept",
    "X-Request-Id": requestId,
  };
}

export type NearAuthorizationResult =
  | { type: "payment-error"; response: { status: number; headers: Record<string, string>; body?: unknown } }
  | {
      type: "payment-verified";
      payer: string;
      transaction: string;
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    };

export type NearSettleResult =
  | { success: true; payer: string; transaction: string; network: NearNetworkId; amount: string; headers: Record<string, string> }
  | { success: false; indeterminate: boolean; response: { status: number; headers: Record<string, string>; body?: unknown } };

function requirementsFor(config: NearX402Config): PaymentRequirements {
  return {
    scheme: "exact",
    network: config.network,
    asset: NEAR_NATIVE_ASSET,
    amount: config.priceYocto,
    payTo: config.payTo,
    maxTimeoutSeconds: 60,
    extra: { name: "NEAR", decimals: 24 },
  };
}

/** Minimal adapter from Node's HTTP request primitives — mirrors the
 * identical helper duplicated across `algorand_gateway.ts` / `qie_gateway.ts`
 * so this module has no dependency on either integration. */
export function createX402HttpContext(input: {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query?: URLSearchParams;
}): { path: string; method: string; url: string; paymentHeader?: string } {
  const header = (name: string): string | undefined => {
    const value = input.headers[name.toLowerCase()] ?? input.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  return {
    path: input.path,
    method: input.method,
    url: input.url,
    paymentHeader: header("payment-signature"),
  };
}

/** NEAR `exact`-scheme x402 resource server. No facilitator client: this
 * class verifies settlement itself against the configured NEAR RPC. */
export class NearCreditScoreGateway {
  constructor(readonly config: NearX402Config) {}

  private challengeResponse(resourceUrl: string, error?: string): NearAuthorizationResult {
    const requirements = requirementsFor(this.config);
    const paymentRequired = {
      x402Version: 2,
      ...(error ? { error } : {}),
      resource: {
        url: resourceUrl,
        description: "Cred402 agent credit score, default probability, eligibility, and verified x402 revenue signals.",
        mimeType: "application/json",
      },
      accepts: [requirements],
    };
    return {
      type: "payment-error",
      response: {
        status: 402,
        headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(paymentRequired) },
        body: {
          error: "payment_required",
          message: error ?? "Pay with native NEAR to access this credit report.",
          price_yocto: this.config.priceYocto,
          network: this.config.network,
        },
      },
    };
  }

  /** Parse and validate an incoming request's `PAYMENT-SIGNATURE` header
   * against this route's requirements. Never touches the network. */
  async authorize(context: { url: string; paymentHeader?: string }): Promise<NearAuthorizationResult> {
    if (!context.paymentHeader) return this.challengeResponse(context.url);

    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(context.paymentHeader);
    } catch {
      return this.challengeResponse(context.url, "PAYMENT-SIGNATURE could not be decoded");
    }

    const requirements = requirementsFor(this.config);
    if (payload.x402Version !== 2) return this.challengeResponse(context.url, "Unsupported x402 version");
    if (payload.accepted?.scheme !== "exact") return this.challengeResponse(context.url, "Unsupported payment scheme");
    if (payload.accepted.network !== requirements.network) return this.challengeResponse(context.url, "Unexpected network");
    if (payload.accepted.asset !== requirements.asset) return this.challengeResponse(context.url, "Unexpected asset");
    if (payload.accepted.payTo !== requirements.payTo) return this.challengeResponse(context.url, "Unexpected pay-to account");
    if (BigInt(payload.accepted.amount) < BigInt(requirements.amount)) {
      return this.challengeResponse(context.url, "Payment amount is below the required price");
    }

    const signerId = typeof payload.payload?.signerId === "string" ? payload.payload.signerId : undefined;
    const transaction = typeof payload.payload?.transaction === "string" ? payload.payload.transaction : undefined;
    if (!signerId || !isValidNearAccountId(signerId)) {
      return this.challengeResponse(context.url, "Payment payload is missing a valid NEAR signer account id");
    }
    if (!transaction || !isValidNearHash(transaction)) {
      return this.challengeResponse(context.url, "Payment payload is missing a valid NEAR transaction hash");
    }

    return {
      type: "payment-verified",
      payer: signerId,
      transaction,
      paymentPayload: payload,
      paymentRequirements: requirements,
    };
  }

  /** Independently verify the claimed transaction against the configured
   * NEAR RPC. This is the facilitator step — self-hosted, with no extra hop. */
  async settle(verified: Extract<NearAuthorizationResult, { type: "payment-verified" }>): Promise<NearSettleResult> {
    const check = await verifyNearAssetTransfer(
      { rpcUrl: this.config.rpcUrl, timeoutMs: this.config.rpcTimeoutMs, minimumFinalityBlocks: this.config.minimumFinalityBlocks },
      { transaction: verified.transaction, payer: verified.payer, receiver: this.config.payTo, amountYocto: this.config.priceYocto },
    );
    if (check.status === "confirmed" || check.status === "pending") {
      const response = {
        success: true as const,
        payer: verified.payer,
        transaction: verified.transaction,
        network: this.config.network,
        amount: this.config.priceYocto,
      };
      return {
        ...response,
        headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(response) },
      };
    }
    const indeterminate = check.status === "unavailable";
    return {
      success: false,
      indeterminate,
      response: {
        status: indeterminate ? 502 : 402,
        headers: {},
        body: {
          error: indeterminate ? "x402_settlement_indeterminate" : "x402_settlement_rejected",
          message: check.reason ?? `NEAR transfer could not be verified (status: ${check.status})`,
        },
      },
    };
  }
}
