import { assertSafeQieEndpoint, type QiePaymentPolicy } from "../lib/x402/qie_client.js";
import { DEFAULT_QIE_TESTNET_RPC_URL } from "../lib/x402/qie_gateway.js";
import { qieNetworkNameFor, type QieNetworkName } from "../lib/x402/qie_networks.js";

export interface QieClientCliConfig {
  endpoint: string;
  policy: QiePaymentPolicy;
}

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function loadQiePayerAddress(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const inline = args.find((arg) => arg.startsWith("--payer="))?.slice("--payer=".length);
  const payer = (inline ?? env.CRED402_QIE_CLIENT_ADDRESS ?? "").trim();
  if (!payer) {
    throw new Error("Set CRED402_QIE_CLIENT_ADDRESS or pass --payer=0xADDRESS");
  }
  if (!isEvmAddress(payer)) throw new Error("Payer is not a valid QIE (EVM) address");
  return payer;
}

/**
 * Resolve the QIE JSON-RPC endpoint to read live balances from. Fails closed
 * on Mainnet: no public QIE Mainnet RPC endpoint is independently confirmed,
 * so Cred402 never guesses one — same pattern as `loadQieX402Config` in
 * `lib/x402/qie_gateway.ts`. Falls back to the confirmed public Testnet RPC.
 */
export function loadQieRpcUrl(
  networkName: QieNetworkName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.CRED402_QIE_RPC_URL?.trim();
  if (configured) {
    try {
      const parsed = new URL(configured);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error("invalid RPC URL");
      }
      return parsed.href;
    } catch {
      throw new Error("CRED402_QIE_RPC_URL must be an HTTP(S) URL without embedded credentials");
    }
  }
  if (networkName === "mainnet") {
    throw new Error(
      "Set CRED402_QIE_RPC_URL: no public QIE Mainnet RPC endpoint is independently confirmed, so Cred402 never guesses one",
    );
  }
  return DEFAULT_QIE_TESTNET_RPC_URL;
}

function positiveIntegerEnv(name: string, value: string): string {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadQieClientCliConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): QieClientCliConfig {
  const endpoint = args.find((arg) => !arg.startsWith("--")) ?? env.CRED402_QIE_CLIENT_URL;
  if (!endpoint) {
    throw new Error("Pass the credit-score endpoint URL or set CRED402_QIE_CLIENT_URL");
  }

  const networkValue = args.includes("--mainnet")
    ? "mainnet"
    : (env.CRED402_QIE_CLIENT_NETWORK ?? "testnet");
  const networkName = qieNetworkNameFor(networkValue.trim());
  if (!networkName) {
    throw new Error("Client network must be testnet or mainnet");
  }
  assertSafeQieEndpoint(endpoint, networkName);

  const expectedPayTo = (
    env.CRED402_QIE_EXPECTED_PAY_TO ?? env.CRED402_QIE_PAY_TO ?? ""
  ).trim();
  if (!expectedPayTo) {
    throw new Error("Set CRED402_QIE_EXPECTED_PAY_TO to the trusted receiver address");
  }
  if (!isEvmAddress(expectedPayTo)) {
    throw new Error("CRED402_QIE_EXPECTED_PAY_TO must be a 0x-prefixed 20-byte EVM address");
  }

  const expectedAssetAddress = (
    env.CRED402_QIE_EXPECTED_ASSET_ADDRESS ?? env.CRED402_QIE_ASSET_ADDRESS ?? ""
  ).trim();
  if (!expectedAssetAddress) {
    throw new Error("Set CRED402_QIE_EXPECTED_ASSET_ADDRESS to the trusted token contract address");
  }
  if (!isEvmAddress(expectedAssetAddress)) {
    throw new Error("CRED402_QIE_EXPECTED_ASSET_ADDRESS must be a 0x-prefixed 20-byte ERC-20 contract address");
  }

  const expectedAmountRaw = (
    env.CRED402_QIE_EXPECTED_PRICE_BASE_UNITS ?? env.CRED402_QIE_PRICE_BASE_UNITS ?? ""
  ).trim();
  const expectedAmountBaseUnits = expectedAmountRaw
    ? positiveIntegerEnv("CRED402_QIE_EXPECTED_PRICE_BASE_UNITS", expectedAmountRaw)
    : undefined;
  const maxAmountBaseUnits = positiveIntegerEnv(
    "CRED402_QIE_MAX_PRICE_BASE_UNITS",
    env.CRED402_QIE_MAX_PRICE_BASE_UNITS?.trim() ?? expectedAmountBaseUnits ?? "10000",
  );

  return {
    endpoint,
    policy: {
      networkName,
      expectedPayTo,
      expectedAssetAddress,
      expectedAmountBaseUnits,
      maxAmountBaseUnits,
      requestUrl: endpoint,
    },
  };
}
