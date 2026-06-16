import { toCasperClientArgs, type RuntimeArg } from "./args.js";

/**
 * Deploy (transaction) construction for Cred402 contract calls.
 *
 * A `DeploySpec` is the fully-typed description of a stored-contract entry-point
 * call — contract hash, entry point, runtime args, payment, chain, sender. This
 * is the part of "going live" that is pure logic and testable offline; signing
 * and CL byte serialization are handled by the injected signer (transport.ts).
 */

export interface DeploySpec {
  contractHash: string; // "hash-..." package/contract hash
  entryPoint: string;
  args: RuntimeArg[];
  paymentMotes: bigint;
  chainName: string;
  sender: string; // sender public key hex ("01.." / "02..")
  ttlMs?: number;
}

export interface BuildContractCallOptions {
  contractHash: string;
  entryPoint: string;
  args: RuntimeArg[];
  paymentMotes: bigint;
  chainName: string;
  sender: string;
  ttlMs?: number;
}

export function buildContractCall(opts: BuildContractCallOptions): DeploySpec {
  if (!opts.contractHash) throw new Error("contractHash required");
  if (!opts.entryPoint) throw new Error("entryPoint required");
  if (opts.paymentMotes <= 0n) throw new Error("paymentMotes must be positive");
  return {
    contractHash: opts.contractHash,
    entryPoint: opts.entryPoint,
    args: opts.args,
    paymentMotes: opts.paymentMotes,
    chainName: opts.chainName,
    sender: opts.sender,
    ttlMs: opts.ttlMs ?? 30 * 60 * 1000,
  };
}

/**
 * Render the exact `casper-client put-deploy` invocation for a spec — the same
 * command an operator would run, and a faithful, copy-pasteable representation of
 * what the signer submits over RPC.
 */
export function toCasperClientCommand(spec: DeploySpec, opts: { nodeAddress: string; secretKeyPath: string }): string {
  const hashHex = spec.contractHash.replace(/^hash-/, "");
  return [
    "casper-client put-deploy",
    `  --node-address ${opts.nodeAddress}`,
    `  --chain-name ${spec.chainName}`,
    `  --secret-key ${opts.secretKeyPath}`,
    `  --session-hash ${hashHex}`,
    `  --session-entry-point ${spec.entryPoint}`,
    `  --payment-amount ${spec.paymentMotes.toString()}`,
    ...spec.args.map((a) => "  " + toCasperClientArgs([a])[0]),
  ].join(" \\\n");
}
