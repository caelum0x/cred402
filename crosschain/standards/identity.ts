import { blake2b256, stableStringify } from "../../lib/core/hash.js";

/**
 * CAID — Cred402 Agent ID (p3 §1). A universal agent identity rooted on Casper:
 *
 *   caid = cred402:<chain>:<agent_id>      e.g. cred402:casper:weather-risk-agent-01
 *
 * Every agent has exactly one canonical CAID, always rooted on `casper`.
 */
export interface Caid {
  protocol: "cred402";
  chain: string;
  agent_id: string;
}

export function makeCaid(agent_id: string, chain = "casper"): string {
  if (!agent_id) throw new Error("agent_id required");
  return `cred402:${chain}:${agent_id}`;
}

export function parseCaid(caid: string): Caid {
  const m = /^cred402:([a-z0-9-]+):(.+)$/.exec(caid);
  if (!m) throw new Error(`invalid CAID: ${caid}`);
  return { protocol: "cred402", chain: m[1]!, agent_id: m[2]! };
}

export function isCaid(value: string): boolean {
  return /^cred402:[a-z0-9-]+:.+$/.test(value);
}

/**
 * UAID — Universal Asset ID (p3 §4). One global ID for an RWA across chains:
 *
 *   uaid = uaid:<asset_type>:<blake2b256(asset_type, jurisdiction, issuer_hash,
 *                                        document_bundle_hash, salt)>
 */
export interface UaidInput {
  asset_type: string;
  jurisdiction: string;
  issuer_hash: string;
  document_bundle_hash: string;
  salt: string;
}

export function makeUaid(input: UaidInput): string {
  const digest = blake2b256(stableStringify(input)); // 0x-prefixed 32-byte hex
  return `uaid:${input.asset_type}:${digest.slice(2)}`;
}

export function parseUaid(uaid: string): { asset_type: string; digest: string } {
  const m = /^uaid:([a-z0-9_-]+):([0-9a-f]{64})$/.exec(uaid);
  if (!m) throw new Error(`invalid UAID: ${uaid}`);
  return { asset_type: m[1]!, digest: m[2]! };
}
