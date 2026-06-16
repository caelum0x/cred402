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
 * The casper-js-sdk signer is imported lazily so the default sim path — and the
 * whole test/demo suite — never loads the SDK. Live mode requires a funded key
 * and a node; missing config fails loud rather than silently degrading.
 */
export interface CasperEnv {
  chain: "sim" | "testnet";
  nodeAddress?: string;
  chainName: string;
  secretKeyPath?: string;
  algorithm: "ed25519" | "secp256k1";
}

export function readCasperEnv(env: NodeJS.ProcessEnv = process.env): CasperEnv {
  const chain = env.CRED402_CHAIN === "testnet" ? "testnet" : "sim";
  return {
    chain,
    nodeAddress: env.CRED402_NODE,
    chainName: env.CRED402_CHAIN_NAME ?? "casper-test",
    secretKeyPath: env.CRED402_SECRET_KEY,
    algorithm: env.CRED402_KEY_ALGO === "secp256k1" ? "secp256k1" : "ed25519",
  };
}

/** True when the environment is fully configured for a live Testnet write path. */
export function isLiveConfigured(env: CasperEnv = readCasperEnv()): boolean {
  return env.chain === "testnet" && Boolean(env.nodeAddress) && Boolean(env.secretKeyPath);
}

/**
 * Build a live {@link CasperTransport} for Testnet. Throws with an actionable
 * message when required env is missing — callers should fall back to the sim
 * {@link LedgerTransport} (which needs no SDK) themselves.
 */
export async function createLiveTransport(env: CasperEnv = readCasperEnv()): Promise<CasperTransport> {
  if (env.chain !== "testnet") {
    throw new Error("CRED402_CHAIN must be 'testnet' for a live transport");
  }
  if (!env.nodeAddress) throw new Error("set CRED402_NODE to a Casper JSON-RPC endpoint");
  if (!env.secretKeyPath) throw new Error("set CRED402_SECRET_KEY to a funded secret-key PEM path");

  // Lazy: only load the SDK-backed signer on the live path.
  const { CasperSdkDeploySigner } = await import("./sdk_signer.js");
  const secretKeyPem = readFileSync(env.secretKeyPath, "utf8");
  const signer = new CasperSdkDeploySigner({
    secretKeyPem,
    algorithm: env.algorithm,
    nodeAddress: env.nodeAddress,
  });
  const rpc = new CasperRpcClient({ nodeAddress: env.nodeAddress });
  return new CasperRpcTransport(rpc, signer);
}
