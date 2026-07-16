import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Chain manifest — the bridge between the live protocol and the real Casper
 * Testnet deployment. Reads `deploys.testnet.json` (the canonical record of the
 * Odra contracts actually installed on-chain) and enriches every contract with a
 * ready-to-open cspr.live explorer URL, so the console can link protocol activity
 * straight to the block explorer instead of showing opaque hashes.
 *
 * This makes on-chain activity observable: every deployed contract, the deployer
 * account, and any deploy hash become one click away from the canonical explorer.
 */

export interface DeployedContract {
  crate: string;
  name: string;
  contract_hash: string;
  status: string;
  /** Absolute cspr.live URL for this contract's on-chain page. */
  explorer_url: string;
}

export interface ChainManifest {
  chain: string;
  mode: string;
  node: string;
  explorer: string;
  deployer_public_key: string;
  deployer_url: string;
  deployed_at: string;
  contract_count: number;
  contracts: DeployedContract[];
}

interface RawManifest {
  chain: string;
  mode: string;
  node: string;
  explorer: string;
  deployer_public_key: string;
  deployed_at: string;
  contracts: Array<{ crate: string; name: string; contract_hash: string; status: string }>;
}

/** cspr.live keys contracts by their raw hex, without the `hash-` CLType prefix. */
export function contractExplorerUrl(explorerBase: string, contractHash: string): string {
  const hex = contractHash.replace(/^hash-/, "");
  return `${explorerBase.replace(/\/$/, "")}/contract/${hex}`;
}

/** cspr.live account page for a Casper public key. */
export function accountExplorerUrl(explorerBase: string, publicKey: string): string {
  return `${explorerBase.replace(/\/$/, "")}/account/${publicKey}`;
}

let cached: ChainManifest | null = null;

/**
 * Load + cache the on-chain deployment manifest. The file is checked into the
 * repo (`deploys.testnet.json`) and never changes at runtime, so it is read once.
 */
export function loadChainManifest(cwd: string = process.cwd()): ChainManifest {
  if (cached) return cached;
  const path = resolve(cwd, "deploys.testnet.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawManifest;
  const explorer = raw.explorer.replace(/\/$/, "");
  cached = {
    chain: raw.chain,
    mode: raw.mode,
    node: raw.node,
    explorer,
    deployer_public_key: raw.deployer_public_key,
    deployer_url: accountExplorerUrl(explorer, raw.deployer_public_key),
    deployed_at: raw.deployed_at,
    contract_count: raw.contracts.length,
    contracts: raw.contracts.map((c) => ({
      crate: c.crate,
      name: c.name,
      contract_hash: c.contract_hash,
      status: c.status,
      explorer_url: contractExplorerUrl(explorer, c.contract_hash),
    })),
  };
  return cached;
}
