import { hashTypedData } from "@casper-ecosystem/casper-eip-712";
import type { PaymentAuthorization } from "./x402.js";

/**
 * Real EIP-712 typed-data digests for Cred402 x402 authorizations (wires
 * `@casper-ecosystem/casper-eip-712`, the official multi-language EIP-712 toolkit
 * for Casper — the same spec the casper-x402 facilitator verifies against).
 *
 * This replaces the previous stable-JSON digest with a standards-compliant
 * `\x19\x01`-framed typed-data hash: `keccak256(0x1901 ‖ domainSeparator ‖
 * hashStruct(message))`. The agent's ed25519 (Casper) key signs this 32-byte
 * digest, so the authorization is verifiable by any EIP-712-aware contract or
 * facilitator, not just by Cred402's own code.
 */

/** Casper-native EIP-712 domain — name/version/chain_name (CAIP-2). */
export const CRED402_EIP712_DOMAIN = {
  name: "Cred402",
  version: "1",
  chain_name: "casper:casper-test",
} as const;

/** Domain field schema (matches CRED402_EIP712_DOMAIN exactly). */
export const CRED402_DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chain_name", type: "string" },
] as const;

/** The EIP-712 struct for an x402 payment authorization. */
export const PAYMENT_AUTHORIZATION_TYPES = {
  PaymentAuthorization: [
    { name: "payment_id", type: "string" },
    { name: "payer_agent", type: "string" },
    { name: "seller_agent", type: "string" },
    { name: "service_type", type: "string" },
    { name: "amount_motes", type: "uint256" },
    { name: "resource", type: "string" },
    { name: "nonce", type: "string" },
  ],
} as const;

/** Map Cred402's network label to its CAIP-2 chain id. */
function chainName(network: string): string {
  switch (network) {
    case "casper-testnet":
      return "casper:casper-test";
    case "casper-mainnet":
      return "casper:casper";
    default:
      return `casper:${network}`;
  }
}

function toHexUint(decimal: string): string {
  return "0x" + BigInt(decimal).toString(16);
}

/**
 * Compute the real EIP-712 digest of a PaymentAuthorization, as a 0x-prefixed
 * 32-byte hex string (deterministic). This is what the agent signs.
 */
export function paymentAuthorizationDigest(auth: PaymentAuthorization): string {
  const domain = {
    name: auth.domain.name,
    version: auth.domain.version,
    chain_name: chainName(auth.domain.network),
  };
  const message = {
    payment_id: auth.payment_id,
    payer_agent: auth.payer_agent,
    seller_agent: auth.seller_agent,
    service_type: auth.service_type,
    amount_motes: toHexUint(auth.amount_motes),
    resource: auth.resource,
    nonce: auth.nonce,
  };
  const digest = hashTypedData(
    domain,
    PAYMENT_AUTHORIZATION_TYPES as unknown as Record<string, Array<{ name: string; type: string }>>,
    "PaymentAuthorization",
    message,
    { domainTypes: CRED402_DOMAIN_TYPES as unknown as Array<{ name: string; type: string }> },
  );
  return "0x" + Buffer.from(digest).toString("hex");
}
