import { readFileSync } from "node:fs";
import { CasperRpcClient } from "./rpc.js";
import { CasperRpcTransport } from "./transport.js";
import type { CasperTransport } from "./transport.js";

/**
 * Transport selection (p8): one switch between the in-memory ledger twin and the
 * real Casper Testnet, driven entirely by environment.
 *
 *   CRED402_CHAIN=sim       (default) → caller uses LedgerTransport (no SDK loaded)
 *   CRED402_CHAIN=testnet            → real CasperRpcTransport + casper-js-sdk signer
 *
 * Live mode auto-enables (without needing CRED402_CHAIN=testnet set separately)
 * the moment both CRED402_CASPER_NODE_URL and CRED402_CASPER_SECRET_KEY_PEM (or
 * the file-path form, CRED402_SECRET_KEY) are present — one less env var an
 * operator has to remember to flip.
 *
 * Two ways to hand over the signing key, both supported:
 *   CRED402_CASPER_SECRET_KEY_PEM — the PEM contents themselves (newlines as \n),
 *                                   convenient for a single Render/CI env var.
 *   CRED402_SECRET_KEY            — a filesystem path to the PEM (local dev).
 *
 * The casper-js-sdk signer is imported lazily so the default sim path — and the
 * whole test/demo suite — never loads the SDK. Live mode requires a funded key
 * and a node; missing config fails loud rather than silently degrading.
 */
export interface CasperEnv {
  chain: "sim" | "testnet";
  nodeAddress?: string;
  chainName: string;
  secretKeyPath?: string;
  /** Raw PEM contents, when provided directly instead of a file path. */
  secretKeyPem?: string;
  algorithm: "ed25519" | "secp256k1";
}

export function readCasperEnv(env: NodeJS.ProcessEnv = process.env): CasperEnv {
  const nodeAddress = env.CRED402_CASPER_NODE_URL ?? env.CRED402_NODE;
  const secretKeyPem = env.CRED402_CASPER_SECRET_KEY_PEM?.replace(/\\n/g, "\n");
  const secretKeyPath = env.CRED402_SECRET_KEY;
  const explicitTestnet = env.CRED402_CHAIN === "testnet";
  const autoLive = Boolean(nodeAddress) && Boolean(secretKeyPem || secretKeyPath);
  const chain = explicitTestnet || autoLive ? "testnet" : "sim";
  return {
    chain,
    nodeAddress,
    chainName: env.CRED402_CHAIN_NAME ?? "casper-test",
    secretKeyPath,
    secretKeyPem,
    algorithm: env.CRED402_KEY_ALGO === "secp256k1" ? "secp256k1" : "ed25519",
  };
}

/** True when the environment is fully configured for a live Testnet write path. */
export function isLiveConfigured(env: CasperEnv = readCasperEnv()): boolean {
  return env.chain === "testnet" && Boolean(env.nodeAddress) && Boolean(env.secretKeyPem || env.secretKeyPath);
}

/**
 * Build a live {@link CasperTransport} for Testnet. Throws with an actionable
 * message when required env is missing — callers should fall back to the sim
 * {@link LedgerTransport} (which needs no SDK) themselves.
 */
export async function createLiveTransport(env: CasperEnv = readCasperEnv()): Promise<CasperTransport> {
  if (env.chain !== "testnet") {
    throw new Error("CRED402_CHAIN must be 'testnet' (or set CRED402_CASPER_NODE_URL + a secret key) for a live transport");
  }
  if (!env.nodeAddress) throw new Error("set CRED402_CASPER_NODE_URL (or CRED402_NODE) to a Casper JSON-RPC endpoint");
  if (!env.secretKeyPem && !env.secretKeyPath) {
    throw new Error("set CRED402_CASPER_SECRET_KEY_PEM (PEM contents) or CRED402_SECRET_KEY (PEM file path) to a funded secret key");
  }

  // Lazy: only load the SDK-backed signer on the live path.
  const { CasperSdkDeploySigner } = await import("./sdk_signer.js");
  const secretKeyPem = env.secretKeyPem ?? readFileSync(env.secretKeyPath!, "utf8");
  const signer = new CasperSdkDeploySigner({
    secretKeyPem,
    algorithm: env.algorithm,
    nodeAddress: env.nodeAddress,
  });
  const rpc = new CasperRpcClient({ nodeAddress: env.nodeAddress });
  return new CasperRpcTransport(rpc, signer);
}
