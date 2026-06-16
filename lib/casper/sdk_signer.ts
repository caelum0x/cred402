// casper-js-sdk ships CommonJS with no ESM "import" condition, so named ESM
// imports don't resolve at runtime. Default-import the module for VALUES and
// type-only import the classes used in type positions (erased at build time).
import Casper from "casper-js-sdk";
import type { Args as ArgsT, CLValue as CLValueT, Deploy as DeployT, PrivateKey as PrivateKeyT, PublicKey as PublicKeyT } from "casper-js-sdk";
import type { RuntimeArg } from "./args.js";
import type { DeploySpec } from "./deploy.js";
import type { DeploySigner } from "./transport.js";

const {
  Args,
  CLValue,
  ContractHash,
  Deploy,
  DeployHeader,
  Duration,
  ExecutableDeployItem,
  HttpHandler,
  Key,
  KeyAlgorithm,
  PrivateKey,
  PublicKey,
  RpcClient,
  StoredContractByHash,
  Timestamp,
} = Casper;

/**
 * CasperSdkDeploySigner — the REAL, byte-exact write path (p8).
 *
 * This is the production signer behind {@link DeploySigner}. It builds a genuine
 * Casper deploy with casper-js-sdk (byte-exact CL serialization, real blake2b
 * deploy hash, real ed25519/secp256k1 signature) and submits it over JSON-RPC via
 * `account_put_deploy`. Nothing is mocked.
 *
 * It is the counterpart to the dependency-free {@link Ed25519DeploySigner}: that
 * one is runnable offline with a hand-rolled canonical hash; this one is
 * byte-exact for Testnet/Mainnet. The transport, args spec, and RPC client are
 * unchanged — only the serialization step differs.
 *
 * Build + sign work fully offline (no node), so a deploy can be constructed and
 * validated in tests without credentials; only {@link signAndSubmit} touches the
 * network.
 */
export interface CasperSdkSignerOptions {
  /** PEM contents of the funded secret key. */
  secretKeyPem: string;
  /** Key algorithm — Casper Testnet faucet keys are ED25519 by default. */
  algorithm?: "ed25519" | "secp256k1";
  /** Node JSON-RPC endpoint, e.g. https://node.testnet.casper.network/rpc. */
  nodeAddress: string;
}

export class CasperSdkDeploySigner implements DeploySigner {
  private readonly privateKey: PrivateKeyT;
  private readonly publicKey: PublicKeyT;
  private readonly rpc: InstanceType<typeof RpcClient>;
  readonly publicKeyHex: string;

  constructor(opts: CasperSdkSignerOptions) {
    const algo = opts.algorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
    this.privateKey = PrivateKey.fromPem(opts.secretKeyPem, algo);
    this.publicKey = this.privateKey.publicKey;
    this.publicKeyHex = this.publicKey.toHex();
    this.rpc = new RpcClient(new HttpHandler(opts.nodeAddress));
  }

  /** Build + sign a byte-exact deploy from a spec, without submitting. */
  buildSignedDeploy(spec: DeploySpec, now: Date = new Date()): DeployT {
    const session = new ExecutableDeployItem();
    session.storedContractByHash = new StoredContractByHash(
      ContractHash.newContract(stripHashPrefix(spec.contractHash)),
      spec.entryPoint,
      toArgs(spec.args),
    );
    const payment = ExecutableDeployItem.standardPayment(spec.paymentMotes.toString());
    const header = new DeployHeader(
      spec.chainName,
      [],
      1,
      new Timestamp(now),
      new Duration(spec.ttlMs ?? 30 * 60 * 1000),
      this.publicKey,
    );
    const deploy = Deploy.makeDeploy(header, payment, session);
    deploy.sign(this.privateKey);
    return deploy;
  }

  /** Sign and submit; returns the on-chain deploy hash. */
  async signAndSubmit(spec: DeploySpec): Promise<string> {
    const deploy = this.buildSignedDeploy(spec);
    if (!deploy.validate()) throw new Error("constructed deploy failed self-validation");
    await this.rpc.putDeploy(deploy);
    return deploy.hash.toHex();
  }
}

/** Map Cred402's serializable {@link RuntimeArg}s to byte-exact CLValues. */
export function toArgs(args: RuntimeArg[]): ArgsT {
  const map: Record<string, CLValueT> = {};
  for (const a of args) map[a.name] = toCLValue(a);
  return Args.fromMap(map);
}

function toCLValue(a: RuntimeArg): CLValueT {
  switch (a.clType) {
    case "String":
      return CLValue.newCLString(a.value);
    case "Bool":
      return CLValue.newCLValueBool(a.value === "true");
    case "U64":
      return CLValue.newCLUint64(BigInt(a.value));
    case "U512":
      return CLValue.newCLUInt512(BigInt(a.value));
    case "Key":
      return CLValue.newCLKey(Key.newKey(`hash-${stripHashPrefix(a.value)}`));
    case "PublicKey":
      return CLValue.newCLPublicKey(PublicKey.fromHex(a.value));
    case "ByteArray":
      return CLValue.newCLByteArray(hexToBytes(a.value));
    default: {
      const exhaustive: never = a.clType;
      throw new Error(`unsupported CLType: ${exhaustive as string}`);
    }
  }
}

function stripHashPrefix(h: string): string {
  return h.replace(/^hash-/, "").replace(/^0x/, "");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${hex}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
