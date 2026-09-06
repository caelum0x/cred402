import { loadChainManifest, type ChainManifest } from "../services/chain_manifest.js";

/**
 * Contract provenance — the honest bridge between the in-memory ledger simulation
 * and the real Casper Testnet deployment.
 *
 * The running server serves credit state from an in-memory simulation of the
 * Cred402 contract suite. Historically this simulation minted a fresh, random
 * `hash-<hex>` per boot for every contract, which was then served from
 * `/api/state`, `/api/contracts`, and the On-Chain console tab as if it were the
 * canonical on-chain address. Those synthetic hashes never matched the real
 * modules installed on Testnet — a dangerous provenance gap for a credit and
 * reputation product.
 *
 * This module replaces that behaviour: the contracts that were actually installed
 * on Casper Testnet carry their REAL package hashes (verifiable on cspr.live),
 * and the contracts that only exist in the simulation are labeled `simulated`
 * with a non-`hash-` identifier that cannot be mistaken for an on-chain address.
 */

export type ContractStatus = "installed" | "simulated";

export interface ContractProvenanceEntry {
  contract_hash: string;
  status: ContractStatus;
  /** Casper chain id when installed on-chain; null for simulation-only contracts. */
  network: string | null;
  /** cspr.live contract page (installed contracts only). */
  explorer_url?: string;
  /** Real install deploy transaction hash (installed contracts only). */
  deploy_hash?: string;
  /** cspr.live deploy page for that install transaction. */
  deploy_url?: string;
}

export interface ContractProvenance {
  /** The running credit state is an in-memory simulation, not live on-chain reads. */
  ledger_mode: "simulation";
  network: string;
  note: string;
  contracts: Record<string, ContractProvenanceEntry>;
}

/**
 * The p3 omnichain + upgrade layer is simulated in-memory and was never installed
 * on Casper Testnet. Rather than hand these synthetic `hash-` values that would
 * masquerade as real deployments, they are labeled `simulated` explicitly.
 */
export const SIMULATED_ONLY_CONTRACTS = [
  "AddressBindingRegistry",
  "ExternalReceiptRegistry",
  "GlobalExposureManager",
  "CreditAuthorizationNotes",
  "UpgradeManager",
] as const;

const LEDGER_MODE_NOTE =
  "Credit state is served from an in-memory simulation of the Cred402 contract suite. " +
  "Entries with status 'installed' carry the real package hash of the module installed on " +
  "Casper Testnet — verify each on cspr.live. Entries with status 'simulated' are part of the " +
  "protocol design but are not yet deployed on-chain.";

/** snake-case, clearly-non-hash identifier for a simulation-only contract. */
function simulatedIdentifier(name: string): string {
  return "sim-" + name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * Build the full contract provenance map: real Testnet hashes for installed
 * contracts, honest `simulated` markers for the rest.
 */
export function buildContractProvenance(cwd?: string): ContractProvenance {
  let manifest: ChainManifest | undefined;
  try {
    manifest = loadChainManifest(cwd);
  } catch {
    // No committed manifest → nothing can be honestly claimed as installed.
    manifest = undefined;
  }

  const contracts: Record<string, ContractProvenanceEntry> = {};
  for (const c of manifest?.contracts ?? []) {
    contracts[c.name] = {
      contract_hash: c.contract_hash,
      status: "installed",
      network: manifest?.chain ?? "casper-test",
      explorer_url: c.explorer_url,
      ...(c.deploy_hash ? { deploy_hash: c.deploy_hash, deploy_url: c.deploy_url } : {}),
    };
  }

  for (const name of SIMULATED_ONLY_CONTRACTS) {
    if (contracts[name]) continue;
    contracts[name] = {
      contract_hash: simulatedIdentifier(name),
      status: "simulated",
      network: null,
    };
  }

  return {
    ledger_mode: "simulation",
    network: manifest?.chain ?? "casper-test",
    note: LEDGER_MODE_NOTE,
    contracts,
  };
}

/**
 * Flat `name → contract_hash` map for the legacy `ledger.contractHashes` shape.
 * Installed contracts resolve to their real Testnet hash; simulation-only
 * contracts resolve to a clearly-labeled `sim-*` identifier.
 */
export function buildContractHashes(cwd?: string): Record<string, string> {
  const provenance = buildContractProvenance(cwd);
  const hashes: Record<string, string> = {};
  for (const [name, entry] of Object.entries(provenance.contracts)) {
    hashes[name] = entry.contract_hash;
  }
  return hashes;
}
