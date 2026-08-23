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
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
  isValidAlgorandAddress,
} from "@x402/avm";
import { ExactAvmScheme } from "@x402/avm/exact/server";
import {
  bazaarResourceServerExtension,
  declareDiscoveryExtension,
  withBazaar,
} from "@x402/extensions/bazaar";

export const ALGORAND_CREDIT_SCORE_ROUTE = "/v1/x402/credit-score/:agentId";
export const ALGORAND_X402_STATUS_ROUTE = "/v1/x402/algorand/status";
export const DEFAULT_ALGORAND_FACILITATOR = "https://facilitator.goplausible.xyz";
export const DEFAULT_CREDIT_SCORE_PRICE_MICRO_USDC = "10000"; // 0.01 USDC

/** Prevent a CDN or browser cache from turning one paid response into a free one. */
export function algorandX402PrivateResponseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Vary: "PAYMENT-SIGNATURE, Accept",
    "X-Request-Id": requestId,
  };
}

export type AlgorandNetworkName = "testnet" | "mainnet";

export interface AlgorandX402Config {
  payTo: string;
  networkName: AlgorandNetworkName;
  network: typeof ALGORAND_TESTNET_CAIP2 | typeof ALGORAND_MAINNET_CAIP2;
  usdcAsset: typeof USDC_TESTNET_ASA_ID | typeof USDC_MAINNET_ASA_ID;
  priceMicroUsdc: string;
  facilitatorUrl: string;
  facilitatorTimeoutMs: number;
  /** Canonical deployment origin used in Bazaar resource URLs. Required on Mainnet. */
  publicBaseUrl?: string;
}

export type AlgorandX402ConfigResult =
  | { enabled: true; config: AlgorandX402Config }
  | { enabled: false; reason: string };

export interface AlgorandX402PublicStatus {
  schema_version: "cred402.algorand-x402-status.v1";
  configured: boolean;
  protocol: "x402-v2";
  paid_route: typeof ALGORAND_CREDIT_SCORE_ROUTE;
  network?: AlgorandX402Config["network"];
  network_name?: AlgorandNetworkName;
  usdc_asset?: AlgorandX402Config["usdcAsset"];
  price_micro_usdc?: string;
  pay_to?: string;
  facilitator_url?: string;
  public_origin?: string;
  discovery: {
    bazaar: true;
    challenge_tag: "x402-global-challenge";
  };
  reason?: string;
}

/** Public, secret-free deployment metadata for probes and release automation. */
export function describeAlgorandX402(
  result: AlgorandX402ConfigResult,
): AlgorandX402PublicStatus {
  const base = {
    schema_version: "cred402.algorand-x402-status.v1" as const,
    configured: result.enabled,
    protocol: "x402-v2" as const,
    paid_route: ALGORAND_CREDIT_SCORE_ROUTE as typeof ALGORAND_CREDIT_SCORE_ROUTE,
    discovery: {
      bazaar: true as const,
      challenge_tag: "x402-global-challenge" as const,
    },
  };
  if (!result.enabled) return { ...base, reason: result.reason };
  return {
    ...base,
    network: result.config.network,
    network_name: result.config.networkName,
    usdc_asset: result.config.usdcAsset,
    price_micro_usdc: result.config.priceMicroUsdc,
    pay_to: result.config.payTo,
    facilitator_url: result.config.facilitatorUrl,
    public_origin: result.config.publicBaseUrl,
  };
}

/**
 * Load the Algorand x402 resource-server configuration. A pay-to address is
 * deliberately mandatory: the paid endpoint must never silently become free or
 * advertise a placeholder recipient.
 */
export function loadAlgorandX402Config(
  env: NodeJS.ProcessEnv = process.env,
): AlgorandX402ConfigResult {
  const payTo = env.CRED402_ALGORAND_PAY_TO?.trim();
  if (!payTo) {
    return {
      enabled: false,
      reason: "CRED402_ALGORAND_PAY_TO is required to enable the paid Algorand endpoint",
    };
  }
  if (!isValidAlgorandAddress(payTo)) {
    return { enabled: false, reason: "CRED402_ALGORAND_PAY_TO is not a valid Algorand address" };
  }

  const rawNetwork = (env.CRED402_ALGORAND_NETWORK ?? "testnet").trim();
  let networkName: AlgorandNetworkName;
  if (rawNetwork === "testnet" || rawNetwork === ALGORAND_TESTNET_CAIP2) networkName = "testnet";
  else if (rawNetwork === "mainnet" || rawNetwork === ALGORAND_MAINNET_CAIP2) networkName = "mainnet";
  else {
    return {
      enabled: false,
      reason: "CRED402_ALGORAND_NETWORK must be testnet, mainnet, or a supported Algorand CAIP-2 id",
    };
  }

  const priceMicroUsdc = (env.CRED402_ALGORAND_PRICE_MICRO_USDC ?? DEFAULT_CREDIT_SCORE_PRICE_MICRO_USDC).trim();
  if (!/^\d+$/.test(priceMicroUsdc) || BigInt(priceMicroUsdc) <= 0n) {
    return {
      enabled: false,
      reason: "CRED402_ALGORAND_PRICE_MICRO_USDC must be a positive integer",
    };
  }

  const rawTimeout = env.CRED402_ALGORAND_FACILITATOR_TIMEOUT_MS ?? "10000";
  const facilitatorTimeoutMs = Number(rawTimeout);
  if (
    !Number.isSafeInteger(facilitatorTimeoutMs) ||
    facilitatorTimeoutMs <= 0 ||
    facilitatorTimeoutMs > 60_000
  ) {
    return {
      enabled: false,
      reason: "CRED402_ALGORAND_FACILITATOR_TIMEOUT_MS must be an integer from 1 to 60000",
    };
  }

  let facilitatorUrl: string;
  try {
    const parsed = new URL(env.CRED402_ALGORAND_FACILITATOR_URL ?? DEFAULT_ALGORAND_FACILITATOR);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("invalid facilitator URL");
    }
    if (parsed.search || parsed.hash) throw new Error("facilitator URL must not contain query or fragment");
    facilitatorUrl = parsed.href.replace(/\/+$/, "");
  } catch {
    return {
      enabled: false,
      reason: "CRED402_ALGORAND_FACILITATOR_URL must be an HTTP(S) URL without credentials, query, or fragment",
    };
  }

  const mainnet = networkName === "mainnet";
  const production = env.NODE_ENV === "production";
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
    return {
      enabled: false,
      reason: "CRED402_PUBLIC_URL must be a pinned HTTPS origin on Mainnet and in production",
    };
  }
  if ((mainnet || production) && !facilitatorUrl.startsWith("https://")) {
    return {
      enabled: false,
      reason: "CRED402_ALGORAND_FACILITATOR_URL must use HTTPS on Mainnet and in production",
    };
  }

  return {
    enabled: true,
    config: {
      payTo,
      networkName,
      network: mainnet ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2,
      usdcAsset: mainnet ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID,
      priceMicroUsdc,
      facilitatorUrl,
      facilitatorTimeoutMs,
      publicBaseUrl,
    },
  };
}

export type VerifiedAlgorandPayment = Extract<HTTPProcessResult, { type: "payment-verified" }>;

/** Official x402 v2 + AVM resource server for Cred402's paid credit-score API. */
export class AlgorandCreditScoreGateway {
  private readonly httpServer: x402HTTPResourceServer;
  private initialization?: Promise<void>;

  constructor(
    readonly config: AlgorandX402Config,
    facilitator?: FacilitatorClient,
  ) {
    const facilitatorClient = facilitator ?? withBazaar(new HTTPFacilitatorClient({
      url: config.facilitatorUrl,
      timeoutMs: config.facilitatorTimeoutMs,
    }));
    const resourceServer = new x402ResourceServer(facilitatorClient)
      .register(config.network, new ExactAvmScheme())
      .registerExtension(bazaarResourceServerExtension);

    this.httpServer = new x402HTTPResourceServer(resourceServer, {
      [`GET ${ALGORAND_CREDIT_SCORE_ROUTE}`]: {
        accepts: {
          scheme: "exact",
          network: config.network,
          payTo: config.payTo,
          price: {
            asset: config.usdcAsset,
            amount: config.priceMicroUsdc,
            extra: { name: "USDC", decimals: 6 },
          },
          maxTimeoutSeconds: 60,
        },
        description: "Cred402 agent credit score, default probability, eligibility, and verified x402 revenue signals.",
        serviceName: "Cred402 Agent Credit Score",
        mimeType: "application/json",
        tags: ["x402-global-challenge", "credit-score", "agentic-finance", "algorand"],
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            message: "Pay with USDC on Algorand to access this credit report.",
            price_micro_usdc: config.priceMicroUsdc,
            network: config.network,
          },
        }),
        extensions: declareDiscoveryExtension({
          pathParams: { agentId: "EvidenceSellerAgent" },
          pathParamsSchema: {
            properties: {
              agentId: {
                type: "string",
                description: "Cred402 agent identifier to score",
              },
            },
            required: ["agentId"],
          },
          output: {
            example: {
              schema_version: "cred402.credit-score.v1",
              agent_id: "EvidenceSellerAgent",
              score: 82,
              risk_band: "low",
              probability_of_default: 0.08,
              eligible: true,
              reason_codes: ["HEALTHY_CREDIT_PROFILE"],
            },
            schema: {
              properties: {
                schema_version: { type: "string" },
                agent_id: { type: "string" },
                score: { type: "integer", minimum: 0, maximum: 100 },
                risk_band: { type: "string", enum: ["low", "moderate", "elevated", "high"] },
                probability_of_default: { type: "number", minimum: 0, maximum: 1 },
                eligible: { type: "boolean" },
                reason_codes: { type: "array", items: { type: "string" } },
              },
              required: ["schema_version", "agent_id", "score", "risk_band", "probability_of_default", "eligible", "reason_codes"],
            },
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
    verified: VerifiedAlgorandPayment,
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

/** Minimal adapter from Node's HTTP request primitives to the x402 core SDK. */
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
