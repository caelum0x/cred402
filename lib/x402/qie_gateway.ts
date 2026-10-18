import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
  type FacilitatorClient,
  type HTTPAdapter,
  type HTTPProcessResult,
  type HTTPRequestContext,
  type ProcessSettleResultResponse,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import {
  QIE_MAINNET_NETWORK,
  QIE_TESTNET_NETWORK,
  qieNetworkNameFor,
  type QieNetworkId,
  type QieNetworkName,
} from "./qie_networks.js";

/**
 * QIE Blockchain Hackathon 3.0 ("AI & Autonomous Agents" track) x402 resource
 * server. QIE is EVM-compatible, so this reuses the exact same chain-agnostic
 * `@x402/core` resource-server primitives the Algorand integration uses
 * (`AlgorandCreditScoreGateway` in `algorand_gateway.ts`) — only the
 * registered scheme (`ExactEvmScheme` from `@x402/evm` instead of
 * `ExactAvmScheme` from `@x402/avm`) and the network/asset configuration
 * differ. No bespoke signing or indexer code, matching the research
 * recommendation that this be "the cheapest integration in the repo."
 *
 * Unlike Algorand's GoPlausible facilitator, no external x402 EVM facilitator
 * for QIE is confirmed to exist yet. Cred402 therefore requires an operator
 * to configure one explicitly (`CRED402_QIE_FACILITATOR_URL`, self-hosted or
 * third-party) — exactly as `CRED402_ALGORAND_PAY_TO` gates the Algorand
 * route, the QIE route stays disabled (503) rather than guessing a default.
 * Likewise, QIE's USDC-backed stablecoin (QUSDC) is documented to exist, but
 * research could not confirm its ERC-20 contract address or testnet
 * availability — `CRED402_QIE_ASSET_ADDRESS` is therefore also mandatory with
 * no default, instead of hardcoding a guessed address.
 */

export const QIE_CREDIT_SCORE_ROUTE = "/v1/x402/qie/credit-score/:agentId";
export const QIE_X402_STATUS_ROUTE = "/v1/x402/qie/status";
export const DEFAULT_QIE_PRICE_BASE_UNITS = "10000"; // 0.01 token at 6 decimals
export const DEFAULT_QIE_ASSET_SYMBOL = "QUSDC";
export const DEFAULT_QIE_ASSET_DECIMALS = 6;
export const DEFAULT_QIE_TESTNET_RPC_URL = "https://rpc1testnet.qie.digital/";
export const QIE_MAINNET_RELEASE_ACK = "I_ACKNOWLEDGE_REAL_QUSDC_MAINNET_PAYMENTS";

export interface QieX402Config {
  releaseTier: "development" | "testnet" | "mainnet";
  payTo: string;
  networkName: QieNetworkName;
  network: QieNetworkId;
  rpcUrl: string;
  rpcTimeoutMs: number;
  minimumConfirmations: number;
  assetAddress: string;
  assetSymbol: string;
  assetDecimals: number;
  priceBaseUnits: string;
  facilitatorUrl: string;
  facilitatorTimeoutMs: number;
  publicBaseUrl?: string;
}

export type QieX402ConfigResult =
  | { enabled: true; config: QieX402Config }
  | { enabled: false; reason: string };

export interface QieX402PublicStatus {
  schema_version: "cred402.qie-x402-status.v1";
  configured: boolean;
  protocol: "x402-v2";
  paid_route: typeof QIE_CREDIT_SCORE_ROUTE;
  network?: QieX402Config["network"];
  network_name?: QieNetworkName;
  asset_address?: string;
  asset_symbol?: string;
  price_base_units?: string;
  pay_to?: string;
  facilitator_url?: string;
  public_origin?: string;
  release_tier?: "development" | "testnet" | "mainnet";
  finality?: {
    rpc_url: string;
    minimum_confirmations: number;
  };
  reason?: string;
}

/** Public, secret-free deployment metadata for probes and release automation. */
export function describeQieX402(result: QieX402ConfigResult): QieX402PublicStatus {
  const base = {
    schema_version: "cred402.qie-x402-status.v1" as const,
    configured: result.enabled,
    protocol: "x402-v2" as const,
    paid_route: QIE_CREDIT_SCORE_ROUTE as typeof QIE_CREDIT_SCORE_ROUTE,
  };
  if (!result.enabled) return { ...base, reason: result.reason };
  return {
    ...base,
    network: result.config.network,
    network_name: result.config.networkName,
    asset_address: result.config.assetAddress,
    asset_symbol: result.config.assetSymbol,
    price_base_units: result.config.priceBaseUnits,
    pay_to: result.config.payTo,
    facilitator_url: result.config.facilitatorUrl,
    public_origin: result.config.publicBaseUrl,
    release_tier: result.config.releaseTier,
    finality: {
      rpc_url: result.config.rpcUrl,
      minimum_confirmations: result.config.minimumConfirmations,
    },
  };
}

function boundedInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number | undefined {
  const value = Number(env[key] ?? fallback);
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : undefined;
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * Load the QIE x402 resource-server configuration. Every field with no
 * confirmed, verifiable default (pay-to address, asset contract, facilitator)
 * is mandatory: the paid endpoint must never silently advertise a placeholder
 * receiver, a guessed token contract, or settle through an unverified facilitator.
 */
export function loadQieX402Config(env: NodeJS.ProcessEnv = process.env): QieX402ConfigResult {
  const payTo = env.CRED402_QIE_PAY_TO?.trim();
  if (!payTo) {
    return { enabled: false, reason: "CRED402_QIE_PAY_TO is required to enable the paid QIE endpoint" };
  }
  if (!isEvmAddress(payTo)) {
    return { enabled: false, reason: "CRED402_QIE_PAY_TO must be a 0x-prefixed 20-byte EVM address" };
  }

  const rawNetwork = (env.CRED402_QIE_NETWORK ?? "testnet").trim();
  const networkName = qieNetworkNameFor(rawNetwork);
  if (!networkName) {
    return { enabled: false, reason: "CRED402_QIE_NETWORK must be testnet, mainnet, or a supported QIE chain id" };
  }
  const mainnet = networkName === "mainnet";

  const production = env.NODE_ENV === "production";
  const releaseTier = env.CRED402_ENV ?? "development";
  if (!new Set(["development", "testnet", "mainnet"]).has(releaseTier)) {
    return { enabled: false, reason: "CRED402_ENV must be development, testnet, or mainnet" };
  }
  if ((releaseTier === "mainnet") !== mainnet) {
    return { enabled: false, reason: "CRED402_ENV=mainnet and CRED402_QIE_NETWORK=mainnet must be enabled together" };
  }
  if (mainnet && env.CRED402_QIE_MAINNET_RELEASE_ACK !== QIE_MAINNET_RELEASE_ACK) {
    return { enabled: false, reason: `CRED402_QIE_MAINNET_RELEASE_ACK must equal ${QIE_MAINNET_RELEASE_ACK}` };
  }

  const assetAddress = env.CRED402_QIE_ASSET_ADDRESS?.trim();
  if (!assetAddress) {
    return {
      enabled: false,
      reason:
        "CRED402_QIE_ASSET_ADDRESS is required: QIE's QUSDC contract address is not independently confirmed per chain, " +
        "so Cred402 never guesses it. Configure the token to charge in explicitly.",
    };
  }
  if (!isEvmAddress(assetAddress)) {
    return { enabled: false, reason: "CRED402_QIE_ASSET_ADDRESS must be a 0x-prefixed 20-byte ERC-20 contract address" };
  }

  let rpcUrl = env.CRED402_QIE_RPC_URL?.trim();
  if (!rpcUrl) {
    if (mainnet) {
      return {
        enabled: false,
        reason: "CRED402_QIE_RPC_URL is required on Mainnet: no public QIE Mainnet RPC endpoint is independently confirmed",
      };
    }
    rpcUrl = DEFAULT_QIE_TESTNET_RPC_URL;
  }
  try {
    const parsed = new URL(rpcUrl);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid RPC URL");
    rpcUrl = parsed.href;
  } catch {
    return { enabled: false, reason: "CRED402_QIE_RPC_URL must be an HTTP(S) URL without embedded credentials" };
  }
  if ((mainnet || production) && !rpcUrl.startsWith("https://")) {
    return { enabled: false, reason: "CRED402_QIE_RPC_URL must use HTTPS on Mainnet and in production" };
  }

  const facilitatorUrlRaw = env.CRED402_QIE_FACILITATOR_URL?.trim();
  if (!facilitatorUrlRaw) {
    return {
      enabled: false,
      reason:
        "CRED402_QIE_FACILITATOR_URL is required: no default x402 EVM facilitator for QIE is confirmed to exist. " +
        "Point this at a self-hosted or third-party x402 V2 facilitator that settles eip155 'exact' payments on QIE.",
    };
  }
  let facilitatorUrl: string;
  try {
    const parsed = new URL(facilitatorUrlRaw);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid facilitator URL");
    if (parsed.search || parsed.hash) throw new Error("facilitator URL must not contain query or fragment");
    facilitatorUrl = parsed.href.replace(/\/+$/, "");
  } catch {
    return {
      enabled: false,
      reason: "CRED402_QIE_FACILITATOR_URL must be an HTTP(S) URL without credentials, query, or fragment",
    };
  }
  if ((mainnet || production) && !facilitatorUrl.startsWith("https://")) {
    return { enabled: false, reason: "CRED402_QIE_FACILITATOR_URL must use HTTPS on Mainnet and in production" };
  }

  if ((mainnet || production) && !env.CRED402_DATA_DIR?.trim()) {
    return {
      enabled: false,
      reason: "CRED402_DATA_DIR is required for durable payment replay protection on Mainnet and in production",
    };
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

  const priceBaseUnits = (env.CRED402_QIE_PRICE_BASE_UNITS ?? DEFAULT_QIE_PRICE_BASE_UNITS).trim();
  if (!/^\d+$/.test(priceBaseUnits) || BigInt(priceBaseUnits) <= 0n) {
    return { enabled: false, reason: "CRED402_QIE_PRICE_BASE_UNITS must be a positive integer" };
  }

  const facilitatorTimeoutMs = boundedInteger(env, "CRED402_QIE_FACILITATOR_TIMEOUT_MS", 10_000, 1, 60_000);
  if (facilitatorTimeoutMs === undefined) {
    return { enabled: false, reason: "CRED402_QIE_FACILITATOR_TIMEOUT_MS must be an integer from 1 to 60000" };
  }
  const rpcTimeoutMs = boundedInteger(env, "CRED402_QIE_RPC_TIMEOUT_MS", 5_000, 250, 30_000);
  if (rpcTimeoutMs === undefined) {
    return { enabled: false, reason: "CRED402_QIE_RPC_TIMEOUT_MS must be an integer from 250 to 30000" };
  }
  const minimumConfirmations = boundedInteger(env, "CRED402_QIE_MIN_CONFIRMATIONS", 2, 1, 1000);
  if (minimumConfirmations === undefined) {
    return { enabled: false, reason: "CRED402_QIE_MIN_CONFIRMATIONS must be an integer from 1 to 1000" };
  }
  const assetDecimals = boundedInteger(env, "CRED402_QIE_ASSET_DECIMALS", DEFAULT_QIE_ASSET_DECIMALS, 0, 18);
  if (assetDecimals === undefined) {
    return { enabled: false, reason: "CRED402_QIE_ASSET_DECIMALS must be an integer from 0 to 18" };
  }

  return {
    enabled: true,
    config: {
      releaseTier: releaseTier as "development" | "testnet" | "mainnet",
      payTo,
      networkName,
      network: mainnet ? QIE_MAINNET_NETWORK : QIE_TESTNET_NETWORK,
      rpcUrl,
      rpcTimeoutMs,
      minimumConfirmations,
      assetAddress,
      assetSymbol: (env.CRED402_QIE_ASSET_SYMBOL?.trim() || DEFAULT_QIE_ASSET_SYMBOL),
      assetDecimals,
      priceBaseUnits,
      facilitatorUrl,
      facilitatorTimeoutMs,
      publicBaseUrl,
    },
  };
}

export type VerifiedQiePayment = Extract<HTTPProcessResult, { type: "payment-verified" }>;

/** x402 v2 + EVM resource server for Cred402's QIE-priced paid credit-score API. */
export class QieCreditScoreGateway {
  private readonly httpServer: x402HTTPResourceServer;
  private initialization?: Promise<void>;

  constructor(
    readonly config: QieX402Config,
    facilitator?: FacilitatorClient,
  ) {
    const facilitatorClient = facilitator ?? new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
      timeoutMs: config.facilitatorTimeoutMs,
    });
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(config.network, new ExactEvmScheme());

    this.httpServer = new x402HTTPResourceServer(resourceServer, {
      [`GET ${QIE_CREDIT_SCORE_ROUTE}`]: {
        accepts: {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: {
            asset: config.assetAddress,
            amount: config.priceBaseUnits,
            extra: { name: config.assetSymbol, decimals: config.assetDecimals },
          },
          maxTimeoutSeconds: 60,
        },
        description: "Cred402 agent credit score, default probability, eligibility, and verified x402 revenue signals (QIE).",
        serviceName: "Cred402 Agent Credit Score (QIE)",
        mimeType: "application/json",
        tags: ["credit-score", "agentic-finance", "qie"],
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            message: `Pay with ${config.assetSymbol} on QIE to access this credit report.`,
            price_base_units: config.priceBaseUnits,
            network: config.network,
          },
        }),
      },
    });
  }

  /** Fetch facilitator capabilities once. A rejected init is retryable. */
  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.httpServer.initialize().catch((error) => {
        this.initialization = undefined;
        throw error;
      });
    }
    await this.initialization;
  }

  async authorize(context: HTTPRequestContext): Promise<HTTPProcessResult> {
    await this.initialize();
    return this.httpServer.processHTTPRequest(context);
  }

  async settle(
    verified: VerifiedQiePayment,
    context: HTTPRequestContext,
    responseBody?: Buffer,
  ): Promise<ProcessSettleResultResponse> {
    return this.httpServer.processSettlement(
      verified.paymentPayload,
      verified.paymentRequirements,
      verified.declaredExtensions,
      { request: context, responseBody },
      undefined,
      verified.beforeHandlerSettlement,
    );
  }
}

/** Prevent a CDN or browser cache from turning one paid response into a free one. */
export function qieX402PrivateResponseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "PAYMENT-SIGNATURE, Accept",
    "X-Request-Id": requestId,
  };
}

/** Minimal adapter from Node's HTTP request primitives to the x402 core SDK
 * (duplicated from `algorand_gateway.ts`'s identical, chain-agnostic helper so
 * this module has no dependency on the Algorand integration). */
export function createX402HttpContext(input: {
  method: string;
  path: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  query?: URLSearchParams;
}): HTTPRequestContext {
  const header = (name: string): string | undefined => {
    const value = input.headers[name.toLowerCase()] ?? input.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const adapter: HTTPAdapter = {
    getHeader: header,
    getMethod: () => input.method,
    getPath: () => input.path,
    getUrl: () => input.url,
    getAcceptHeader: () => header("accept") ?? "application/json",
    getUserAgent: () => header("user-agent") ?? "",
    getQueryParams: () => Object.fromEntries(input.query?.entries() ?? []),
    getQueryParam: (name) => input.query?.get(name) ?? undefined,
  };
  return {
    adapter,
    path: input.path,
    method: input.method,
    paymentHeader: header("payment-signature"),
  };
}
