import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_MAINNET_GENESIS_HASH,
  ALGORAND_TESTNET_CAIP2,
  ALGORAND_TESTNET_GENESIS_HASH,
} from "@x402/avm";

/**
 * Algorand network identifiers as the GoPlausible facilitator and the Bazaar use them:
 * `algorand:` followed by the **full** 44-character genesis hash.
 *
 * `@x402/avm` exports `ALGORAND_*_CAIP2` constants truncated to 32 characters, because
 * CAIP-2 caps a chain reference at 32. The facilitator's `GET /supported` and every
 * catalogued Bazaar resource use the untruncated hash instead, and the resource server
 * matches facilitator capabilities by exact string. Registering a route with the
 * truncated form therefore fails capability matching outright:
 *
 *   502 x402_facilitator_unavailable — Facilitator does not support scheme "exact"
 *   on network "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k"
 *
 * The truncated form would also be wrong on the wire: it is what we would advertise in
 * `PAYMENT-REQUIRED` and what the Bazaar would record, so buyers keyed on the full hash
 * could not match our offer.
 *
 * Using the full form is safe in both directions. The SDK's own
 * `normalizeAlgorandNetwork` accepts `algorand:<full genesis hash>` and maps it back to
 * the truncated CAIP-2 constant internally, so the AVM scheme still resolves the right
 * genesis hash when it builds and verifies transactions.
 */
export const ALGORAND_MAINNET_NETWORK = `algorand:${ALGORAND_MAINNET_GENESIS_HASH}` as const;
export const ALGORAND_TESTNET_NETWORK = `algorand:${ALGORAND_TESTNET_GENESIS_HASH}` as const;

export type AlgorandNetworkId =
  | typeof ALGORAND_MAINNET_NETWORK
  | typeof ALGORAND_TESTNET_NETWORK;

/** Every spelling of a network we accept in configuration, per network. */
const MAINNET_ALIASES: readonly string[] = [
  "mainnet",
  ALGORAND_MAINNET_NETWORK,
  ALGORAND_MAINNET_CAIP2,
];
const TESTNET_ALIASES: readonly string[] = [
  "testnet",
  ALGORAND_TESTNET_NETWORK,
  ALGORAND_TESTNET_CAIP2,
];

/**
 * Resolve a configured network string to a network name, accepting the friendly name,
 * the full genesis-hash id, and the truncated CAIP-2 id. Returns undefined for anything
 * else so callers can fail closed.
 */
export function algorandNetworkNameFor(raw: string): "mainnet" | "testnet" | undefined {
  if (MAINNET_ALIASES.includes(raw)) return "mainnet";
  if (TESTNET_ALIASES.includes(raw)) return "testnet";
  return undefined;
}

export function algorandNetworkIdFor(name: "mainnet" | "testnet"): AlgorandNetworkId {
  return name === "mainnet" ? ALGORAND_MAINNET_NETWORK : ALGORAND_TESTNET_NETWORK;
}
