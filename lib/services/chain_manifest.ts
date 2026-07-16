import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Chain manifest — the bridge between the live protocol and the real Casper
 * Testnet deployment. Reads `deploys.testnet.json` (the canonical record of the
 * Odra contracts actually installed on-chain) and `deploys.transactions.json`
 * (the real install deploy transactions, pulled from cspr.live), then enriches
 * every contract with ready-to-open cspr.live URLs — for the contract page, and
 * for the exact on-chain deploy transaction that installed it.
 *
 * This makes on-chain activity observable and verifiable: every deployed
 * contract, the deployer account, and the real deploy transactions we made are
 * one click away from the canonical block explorer.
 */

export interface DeployedContract {
  crate: string;
  name: string;
  contract_hash: string;
  status: string;
  /** Absolute cspr.live URL for this contract's on-chain page. */
  explorer_url: string;
  /** Real deploy hash of the transaction that installed this contract, if known. */
  deploy_hash?: string;
  /** Absolute cspr.live URL for that install deploy transaction. */
  deploy_url?: string;
}

export interface DeployTransaction {
  deploy_hash: string;
  contract: string;
  block_height: number;
  timestamp: string;
  /** Absolute cspr.live URL for this deploy transaction. */
  deploy_url: string;
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
  /** Real on-chain install deploys we made, newest first (from cspr.live). */
  transactions: DeployTransaction[];
  transaction_count: number;
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

interface RawTransactions {
  deploys: Array<{ deploy_hash: string; contract: string; block_height: number; timestamp: string }>;
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

/** cspr.live page for a Casper deploy (transaction) hash. */
export function deployExplorerUrl(explorerBase: string, deployHash: string): string {
  return `${explorerBase.replace(/\/$/, "")}/deploy/${deployHash}`;
}

/** Load the committed real-deploy transaction log; empty + tolerant if absent. */
function loadTransactions(cwd: string, explorer: string): DeployTransaction[] {
  try {
    const raw = JSON.parse(readFileSync(resolve(cwd, "deploys.transactions.json"), "utf8")) as RawTransactions;
    return raw.deploys.map((d) => ({
      deploy_hash: d.deploy_hash,
      contract: d.contract,
      block_height: d.block_height,
      timestamp: d.timestamp,
      deploy_url: deployExplorerUrl(explorer, d.deploy_hash),
    }));
  } catch {
    return [];
  }
}

let cached: ChainManifest | null = null;

/**
 * Load + cache the on-chain deployment manifest. The files are checked into the
 * repo and never change at runtime, so they are read once.
 */
export function loadChainManifest(cwd: string = process.cwd()): ChainManifest {
  if (cached) return cached;
  const path = resolve(cwd, "deploys.testnet.json");
  const raw = JSON.parse(readFileSync(path, "utf8")) as RawManifest;
  const explorer = raw.explorer.replace(/\/$/, "");
  const transactions = loadTransactions(cwd, explorer);

  // Latest install deploy per contract → the tx whose contract is live now.
  const latestByContract = new Map<string, DeployTransaction>();
  for (const tx of transactions) {
    const prev = latestByContract.get(tx.contract);
    if (!prev || tx.block_height > prev.block_height) latestByContract.set(tx.contract, tx);
  }

  cached = {
    chain: raw.chain,
    mode: raw.mode,
    node: raw.node,
    explorer,
    deployer_public_key: raw.deployer_public_key,
    deployer_url: accountExplorerUrl(explorer, raw.deployer_public_key),
    deployed_at: raw.deployed_at,
    contract_count: raw.contracts.length,
    contracts: raw.contracts.map((c) => {
      const install = latestByContract.get(c.name);
      return {
        crate: c.crate,
        name: c.name,
        contract_hash: c.contract_hash,
        status: c.status,
        explorer_url: contractExplorerUrl(explorer, c.contract_hash),
        ...(install ? { deploy_hash: install.deploy_hash, deploy_url: install.deploy_url } : {}),
      };
    }),
    transactions,
    transaction_count: transactions.length,
  };
  return cached;
}
