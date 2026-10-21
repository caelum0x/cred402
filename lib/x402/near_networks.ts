/**
 * NEAR network identifiers for the NEAR Hackathon (Nov 1-14, 2026,
 * nearhackathon.com) "Agent Economy" / "AI Security & Defense" tracks.
 *
 * x402's generic `Network` type is `${string}:${string}` (see
 * `@x402/core/types`), so Cred402 identifies NEAR the same way the ecosystem
 * identifies every other non-EVM chain it has no dedicated `@x402/*` package
 * for yet: a simple `near:<network>` pair rather than a CAIP-2 `eip155:`-style
 * id (NEAR has no CAIP-2 namespace registered at the time of writing).
 *
 * Unlike Algorand (GoPlausible facilitator) and QIE (requires an operator to
 * configure a third-party facilitator), the NEAR route needs no facilitator
 * at all: `near_gateway.ts` verifies settlement itself, directly against the
 * configured NEAR RPC endpoint (`near_finality.ts`), the same way a
 * self-hosted x402 facilitator would.
 */

export const NEAR_TESTNET_NETWORK = "near:testnet" as const;
export const NEAR_MAINNET_NETWORK = "near:mainnet" as const;

export type NearNetworkId = typeof NEAR_TESTNET_NETWORK | typeof NEAR_MAINNET_NETWORK;
export type NearNetworkName = "testnet" | "mainnet";

export const DEFAULT_NEAR_RPC_URL: Record<NearNetworkName, string> = {
  testnet: "https://rpc.testnet.near.org",
  mainnet: "https://rpc.mainnet.near.org",
};

const MAINNET_ALIASES: readonly string[] = ["mainnet", NEAR_MAINNET_NETWORK];
const TESTNET_ALIASES: readonly string[] = ["testnet", NEAR_TESTNET_NETWORK];

/** Resolve a configured network string, accepting the friendly name or the
 * `near:<network>` id. Returns undefined to fail closed. */
export function nearNetworkNameFor(raw: string): NearNetworkName | undefined {
  if (MAINNET_ALIASES.includes(raw)) return "mainnet";
  if (TESTNET_ALIASES.includes(raw)) return "testnet";
  return undefined;
}

export function nearNetworkIdFor(name: NearNetworkName): NearNetworkId {
  return name === "mainnet" ? NEAR_MAINNET_NETWORK : NEAR_TESTNET_NETWORK;
}

/** NEAR account ids: 2-64 chars, lowercase alphanumeric plus `. _ -`, no
 * leading/trailing separator, no consecutive separators. Implicit (hex
 * public-key) accounts are a 64-character lowercase hex string, which this
 * pattern also accepts. */
const NEAR_ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export function isValidNearAccountId(value: string): boolean {
  return NEAR_ACCOUNT_ID.test(value);
}

/** NEAR transaction / block hashes are base58-encoded 32-byte digests
 * (43-44 base58 characters). */
export const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function isValidNearHash(value: string): boolean {
  return NEAR_HASH.test(value);
}
