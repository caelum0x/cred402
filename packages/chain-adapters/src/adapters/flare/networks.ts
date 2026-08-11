/**
 * Real Flare-family network constants. Flare is an EVM Layer 1 with enshrined
 * data protocols (FTSO price feeds, FDC cross-chain attestation) and FAssets
 * (FXRP) — the substrate for Cred402's interoperable-asset credit satellite.
 *
 * The FlareContractRegistry has the SAME address on every network, so every
 * enshrined contract (FtsoV2, FdcHub, FdcVerification, the FXRP AssetManager) is
 * resolved at runtime rather than hardcoded — the pattern Flare's own guides use.
 *
 * Sources:
 *   https://dev.flare.network/network/overview  (chain ids, RPCs)
 *   https://dev.flare.network/network/solidity-reference (ContractRegistry)
 */

export interface FlareNetwork {
  key: "flare" | "songbird" | "coston2" | "coston";
  chainId: number;
  caip2: string; // eip155:<chainId>
  /** KeeperHub-style numeric chain id string. */
  keeperhubChainId: string;
  name: string;
  rpcUrl: string;
  explorer: string;
  nativeSymbol: string;
  testnet: boolean;
}

/** Same on Flare, Songbird, Coston2, Coston. */
export const FLARE_CONTRACT_REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";

export const FLARE_NETWORKS: Record<FlareNetwork["key"], FlareNetwork> = {
  flare: {
    key: "flare",
    chainId: 14,
    caip2: "eip155:14",
    keeperhubChainId: "14",
    name: "Flare Mainnet",
    rpcUrl: "https://flare-api.flare.network/ext/C/rpc",
    explorer: "https://flare-explorer.flare.network",
    nativeSymbol: "FLR",
    testnet: false,
  },
  songbird: {
    key: "songbird",
    chainId: 19,
    caip2: "eip155:19",
    keeperhubChainId: "19",
    name: "Songbird Canary",
    rpcUrl: "https://songbird-api.flare.network/ext/C/rpc",
    explorer: "https://songbird-explorer.flare.network",
    nativeSymbol: "SGB",
    testnet: false,
  },
  coston2: {
    key: "coston2",
    chainId: 114,
    caip2: "eip155:114",
    keeperhubChainId: "114",
    name: "Flare Testnet Coston2",
    rpcUrl: "https://coston2-api.flare.network/ext/C/rpc",
    explorer: "https://coston2-explorer.flare.network",
    nativeSymbol: "C2FLR",
    testnet: true,
  },
  coston: {
    key: "coston",
    chainId: 16,
    caip2: "eip155:16",
    keeperhubChainId: "16",
    name: "Songbird Testnet Coston",
    rpcUrl: "https://coston-api.flare.network/ext/C/rpc",
    explorer: "https://coston-explorer.flare.network",
    nativeSymbol: "CFLR",
    testnet: true,
  },
};

/** Resolve a network by CAIP-2, numeric chain id, or key. Defaults to Coston2. */
export function resolveFlareNetwork(idOrKey?: string | number): FlareNetwork {
  if (idOrKey === undefined) return FLARE_NETWORKS.coston2;
  const s = String(idOrKey).toLowerCase();
  for (const net of Object.values(FLARE_NETWORKS)) {
    if (net.key === s || net.caip2 === s || String(net.chainId) === s) return net;
  }
  return FLARE_NETWORKS.coston2;
}

/** cspr.live-style explorer deep links for a Flare tx / address. */
export function flareTxUrl(net: FlareNetwork, txHash: string): string {
  return `${net.explorer}/tx/${txHash}`;
}
export function flareAddressUrl(net: FlareNetwork, address: string): string {
  return `${net.explorer}/address/${address}`;
}
