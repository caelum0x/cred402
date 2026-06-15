import { stableStringify, blake2b256 } from "../../lib/core/hash.js";
import { sign as edSign, verifyCasperHex } from "../../lib/x402/keys.js";
import { evmSign, evmVerify } from "../../lib/x402/evm.js";

/**
 * ABE — Address Binding Envelope (p3 §2). Binds a non-Casper address to a
 * Casper-rooted agent. BOTH sides sign, so neither key alone can claim the
 * binding. Casper side: ed25519. EVM side: secp256k1 (real signatures).
 */
export interface AddressBindingEnvelope {
  type: "Cred402AddressBinding";
  version: "1";
  agent_id: string;
  casper_account: string; // "01"+hex ed25519 public key
  external_chain: string; // e.g. "eip155:8453"
  external_address: string; // e.g. "0xA91..."
  nonce: string;
  expires_at: number;
  casper_signature?: string;
  external_signature?: string;
}

/** The canonical bytes both parties sign (envelope without the signature fields). */
export function bindingSigningPayload(abe: AddressBindingEnvelope): string {
  const { casper_signature, external_signature, ...unsigned } = abe;
  void casper_signature;
  void external_signature;
  return stableStringify(unsigned);
}

export function buildAddressBinding(args: {
  agent_id: string;
  casper_account: string;
  casper_private_pem: string;
  external_chain: string;
  external_address: string;
  external_private_key: string; // secp256k1 0x hex
  expires_at: number;
  nonce?: string;
}): AddressBindingEnvelope {
  const base: AddressBindingEnvelope = {
    type: "Cred402AddressBinding",
    version: "1",
    agent_id: args.agent_id,
    casper_account: args.casper_account,
    external_chain: args.external_chain,
    external_address: args.external_address,
    nonce: args.nonce ?? blake2b256(`${args.agent_id}:${args.external_address}:${args.expires_at}`),
    expires_at: args.expires_at,
  };
  const payload = bindingSigningPayload(base);
  return {
    ...base,
    casper_signature: edSign(args.casper_private_pem, payload),
    external_signature: evmSign(args.external_private_key, payload),
  };
}

export function verifyAddressBinding(abe: AddressBindingEnvelope, now: number): { ok: boolean; reason?: string } {
  if (abe.type !== "Cred402AddressBinding") return { ok: false, reason: "wrong type" };
  if (!abe.casper_signature || !abe.external_signature) return { ok: false, reason: "missing signature" };
  if (now > abe.expires_at) return { ok: false, reason: "binding expired" };
  const payload = bindingSigningPayload(abe);
  if (!verifyCasperHex(abe.casper_account, payload, abe.casper_signature)) {
    return { ok: false, reason: "invalid casper signature" };
  }
  if (!evmVerify(payload, abe.external_signature, abe.external_address)) {
    return { ok: false, reason: "invalid external signature" };
  }
  return { ok: true };
}
