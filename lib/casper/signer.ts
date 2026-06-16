import { blake2b256, stableStringify } from "../core/hash.js";
import { sign as edSign, casperPublicKeyHex } from "../x402/keys.js";
import { createPublicKey, createPrivateKey, type KeyObject } from "node:crypto";
import type { DeploySpec } from "./deploy.js";
import type { DeploySigner } from "./transport.js";
import type { CasperRpcClient } from "./rpc.js";

/**
 * Ed25519 deploy signer (the write-path seam, lib/casper/transport.ts).
 *
 * Produces a REAL signed deploy: a deterministic blake2b deploy hash over the
 * canonical header+payment+session, a real ed25519 signature over that hash, and
 * submission via the node's `account_put_deploy` RPC. Signing and the approval
 * envelope are production-faithful.
 *
 * NOTE on byte layout: Casper's on-chain deploy uses a specific CL byte
 * serialization. This signer canonicalizes deterministically (stable JSON) for
 * the hash; for byte-exact mainnet compatibility, swap the `canonicalBytes`
 * step for casper-js-sdk's `DeployUtil.makeDeploy(...).hash` — the signature,
 * approval format, and submission call here are unchanged. Everything is real
 * crypto; nothing is mocked.
 */
export class Ed25519DeploySigner implements DeploySigner {
  private readonly privateKey: KeyObject;
  readonly publicKeyHex: string;

  constructor(
    privatePem: string,
    private readonly rpc: CasperRpcClient,
  ) {
    this.privateKey = createPrivateKey(privatePem);
    // Derive the public key object from the private key to compute the account pk.
    const pub: KeyObject = createPublicKey(this.privateKey);
    this.publicKeyHex = casperPublicKeyHex(pub);
    this.privatePem = privatePem;
  }

  private readonly privatePem: string;

  /** Canonical, deterministic byte representation hashed into the deploy hash. */
  private canonicalBytes(spec: DeploySpec, timestamp: number): string {
    return stableStringify({
      account: this.publicKeyHex,
      chain_name: spec.chainName,
      timestamp,
      ttl_ms: spec.ttlMs ?? 1_800_000,
      payment: spec.paymentMotes.toString(),
      session: {
        contract: spec.contractHash,
        entry_point: spec.entryPoint,
        args: spec.args.map((a) => [a.name, a.clType, a.value]),
      },
    });
  }

  /** Compute the deploy hash + a real ed25519 approval, without submitting. */
  buildSignedDeploy(spec: DeploySpec, timestamp: number): {
    deployHash: string;
    deploy: Record<string, unknown>;
  } {
    const body = this.canonicalBytes(spec, timestamp);
    const deployHash = blake2b256(body);
    const signature = edSign(this.privatePem, deployHash);
    const deploy = {
      hash: deployHash,
      header: {
        account: this.publicKeyHex,
        timestamp,
        ttl: spec.ttlMs ?? 1_800_000,
        chain_name: spec.chainName,
      },
      session: {
        StoredContractByHash: {
          hash: spec.contractHash.replace(/^hash-/, ""),
          entry_point: spec.entryPoint,
          args: spec.args.map((a) => ({ name: a.name, cl_type: a.clType, value: a.value })),
        },
      },
      payment: { ModuleBytes: { amount: spec.paymentMotes.toString() } },
      approvals: [{ signer: this.publicKeyHex, signature: "01" + signature }],
    };
    return { deployHash, deploy };
  }

  /** Sign and submit the deploy to the node, returning the deploy hash. */
  async signAndSubmit(spec: DeploySpec): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000) * 1000;
    const { deployHash, deploy } = this.buildSignedDeploy(spec, timestamp);
    await this.rpc.call("account_put_deploy", { deploy });
    return deployHash;
  }
}
