import type { AlgorandClientNetwork, AlgorandPaymentPolicy } from "../lib/x402/algorand_client.js";
import { assertSafeAlgorandEndpoint } from "../lib/x402/algorand_client.js";
import { isValidAlgorandAddress } from "@x402/avm";

export interface AlgorandClientCliConfig {
  endpoint: string;
  policy: AlgorandPaymentPolicy;
}

export function loadAlgorandPayerAddress(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const inline = args.find((arg) => arg.startsWith("--payer="))?.slice("--payer=".length);
  const payer = (inline ?? env.CRED402_ALGORAND_CLIENT_ADDRESS ?? "").trim();
  if (!payer) {
    throw new Error("Set CRED402_ALGORAND_CLIENT_ADDRESS or pass --payer=PUBLIC_ADDRESS");
  }
  if (!isValidAlgorandAddress(payer)) throw new Error("Payer is not a valid Algorand address");
  return payer;
}

function positiveIntegerEnv(name: string, value: string): string {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n) throw new Error(`${name} must be a positive integer`);
  return value;
}

export function loadAlgorandClientCliConfig(
  args: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): AlgorandClientCliConfig {
  const endpoint = args.find((arg) => !arg.startsWith("--")) ?? env.CRED402_ALGORAND_CLIENT_URL;
  if (!endpoint) {
    throw new Error(
      "Pass the credit-score endpoint URL or set CRED402_ALGORAND_CLIENT_URL",
    );
  }

  const networkValue = args.includes("--mainnet")
    ? "mainnet"
    : (env.CRED402_ALGORAND_CLIENT_NETWORK ?? env.CRED402_ALGORAND_NETWORK ?? "testnet");
  if (networkValue !== "testnet" && networkValue !== "mainnet") {
    throw new Error("Client network must be testnet or mainnet");
  }
  const networkName: AlgorandClientNetwork = networkValue;
  assertSafeAlgorandEndpoint(endpoint, networkName);

  const expectedPayTo = (
    env.CRED402_ALGORAND_EXPECTED_PAY_TO ?? env.CRED402_ALGORAND_PAY_TO ?? ""
  ).trim();
  if (!expectedPayTo) {
    throw new Error(
      "Set CRED402_ALGORAND_EXPECTED_PAY_TO to the trusted receiver address",
    );
  }

  const expectedAmountMicroUsdc = positiveIntegerEnv(
    "CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC",
    env.CRED402_ALGORAND_EXPECTED_PRICE_MICRO_USDC ??
      env.CRED402_ALGORAND_PRICE_MICRO_USDC ??
      "10000",
  );
  const maxAmountMicroUsdc = positiveIntegerEnv(
    "CRED402_ALGORAND_MAX_PRICE_MICRO_USDC",
    env.CRED402_ALGORAND_MAX_PRICE_MICRO_USDC ?? expectedAmountMicroUsdc,
  );

  return {
    endpoint,
    policy: {
      networkName,
      expectedPayTo,
      expectedAmountMicroUsdc,
      maxAmountMicroUsdc,
      requestUrl: endpoint,
    },
  };
}
