import type { ChainManifest, DeployedContract } from "../api";

/**
 * cspr.live explorer helpers. The console mirrors real Casper Testnet contracts,
 * so wherever we show a contract, account or deploy hash we can link straight to
 * the canonical block explorer — making on-chain activity observable in one click.
 */

/** Deploy page for a Casper deploy hash on the given explorer base. */
export function deployUrl(explorerBase: string, deployHash: string): string {
  return `${explorerBase.replace(/\/$/, "")}/deploy/${deployHash}`;
}

/** Account page for a Casper public key on the given explorer base. */
export function accountUrl(explorerBase: string, publicKey: string): string {
  return `${explorerBase.replace(/\/$/, "")}/account/${publicKey}`;
}

/**
 * Index a manifest's contracts by name for O(1) lookup when decorating events.
 * Several protocol sub-modules (e.g. RWAJobBoard, GlobalExposureManager) are not
 * separately deployed on-chain, so a lookup miss simply means "no explorer link".
 */
export function indexContracts(manifest: ChainManifest | null): Map<string, DeployedContract> {
  const map = new Map<string, DeployedContract>();
  if (!manifest) return map;
  for (const c of manifest.contracts) map.set(c.name, c);
  return map;
}
