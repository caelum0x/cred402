/**
 * QIE network identifiers for the QIE Blockchain Hackathon 3.0 ("AI & Autonomous
 * Agents" track, hackathon.qie.digital). QIE is an EVM-compatible Layer-1 (Cosmos
 * SDK consensus + Ethereum JSON-RPC `eth_*` compatibility), so the x402 "exact"
 * scheme identifies it with a standard CAIP-2 `eip155:<chainId>` network id —
 * the same shape used by every other EVM chain the x402 ecosystem supports.
 *
 * Chain ids (confirmed against the hackathon's own builder quickstart and
 * independent chain-listing sites, both pointing at the qie.digital domain):
 *   - Testnet: 1983 (`eip155:1983`)
 *   - Mainnet: 1990 (`eip155:1990`, Cosmos-SDK chain id string `qie_1990-1`)
 *
 * Do not confuse this with the unrelated "QIE Blockchain" / "QIEMainnet" listing
 * on some chain-list aggregators that uses chain id 5656 on the qiblockchain.online
 * domain — that is a different project.
 */

export const QIE_TESTNET_CHAIN_ID = 1983;
export const QIE_MAINNET_CHAIN_ID = 1990;

export const QIE_TESTNET_NETWORK = `eip155:${QIE_TESTNET_CHAIN_ID}` as const;
export const QIE_MAINNET_NETWORK = `eip155:${QIE_MAINNET_CHAIN_ID}` as const;

export type QieNetworkId = typeof QIE_TESTNET_NETWORK | typeof QIE_MAINNET_NETWORK;
export type QieNetworkName = "testnet" | "mainnet";

const MAINNET_ALIASES: readonly string[] = [
  "mainnet",
  QIE_MAINNET_NETWORK,
  String(QIE_MAINNET_CHAIN_ID),
];
const TESTNET_ALIASES: readonly string[] = [
  "testnet",
  QIE_TESTNET_NETWORK,
  String(QIE_TESTNET_CHAIN_ID),
];

/** Resolve a configured network string, accepting the friendly name, the
 * CAIP-2 id, or the bare numeric chain id. Returns undefined to fail closed. */
export function qieNetworkNameFor(raw: string): QieNetworkName | undefined {
  if (MAINNET_ALIASES.includes(raw)) return "mainnet";
  if (TESTNET_ALIASES.includes(raw)) return "testnet";
  return undefined;
}

export function qieNetworkIdFor(name: QieNetworkName): QieNetworkId {
  return name === "mainnet" ? QIE_MAINNET_NETWORK : QIE_TESTNET_NETWORK;
}

export function qieChainIdFor(name: QieNetworkName): number {
  return name === "mainnet" ? QIE_MAINNET_CHAIN_ID : QIE_TESTNET_CHAIN_ID;
}

/** `0x`-prefixed hex chain id, as returned by `eth_chainId`. */
export function qieHexChainIdFor(name: QieNetworkName): string {
  return `0x${qieChainIdFor(name).toString(16)}`;
}
