import { readFileSync } from "node:fs";
import Casper from "casper-js-sdk";
import type { Deploy as DeployT, PrivateKey as PrivateKeyT, PublicKey as PublicKeyT } from "casper-js-sdk";
import { toArgs } from "./sdk_signer.js";
import { CasperRpcClient } from "./rpc.js";
import type { RuntimeArg } from "./args.js";

const {
  Args,
  Deploy,
  DeployHeader,
  Duration,
  ExecutableDeployItem,
  HttpHandler,
  KeyAlgorithm,
  PrivateKey,
  RpcClient,
  Timestamp,
} = Casper;

/**
 * Real WASM contract installation (p8).
 *
 * Installs an Odra-compiled `.wasm` to Casper as a `ModuleBytes` deploy — the
 * genuine "put a contract on chain" path. Build + sign are offline-safe; only
 * {@link installContract} submits over RPC. After execution, the installed
 * contract's package hash is resolved from the deployer account's named keys
 * (the convention Odra installers follow).
 */
export interface InstallOptions {
  wasmPath: string;
  args?: RuntimeArg[];
  paymentMotes: bigint;
  chainName: string;
  nodeAddress: string;
  secretKeyPem: string;
  algorithm?: "ed25519" | "secp256k1";
  ttlMs?: number;
}

export interface InstallResult {
  deployHash: string;
  account: string;
}

function loadKey(pem: string, algorithm?: "ed25519" | "secp256k1"): PrivateKeyT {
  const algo = algorithm === "secp256k1" ? KeyAlgorithm.SECP256K1 : KeyAlgorithm.ED25519;
  return PrivateKey.fromPem(pem, algo);
}

/** Build + sign a byte-exact installation deploy (no network). */
export function buildInstallDeploy(opts: InstallOptions, now: Date = new Date()): { deploy: DeployT; account: string } {
  const wasm = new Uint8Array(readFileSync(opts.wasmPath));
  const key = loadKey(opts.secretKeyPem, opts.algorithm);
  const pub: PublicKeyT = key.publicKey;
  const session = ExecutableDeployItem.newModuleBytes(wasm, opts.args ? toArgs(opts.args) : Args.fromMap({}));
  const payment = ExecutableDeployItem.standardPayment(opts.paymentMotes.toString());
  const header = new DeployHeader(
    opts.chainName,
    [],
    1,
    new Timestamp(now),
    new Duration(opts.ttlMs ?? 30 * 60 * 1000),
    pub,
  );
  const deploy = Deploy.makeDeploy(header, payment, session);
  deploy.sign(key);
  return { deploy, account: pub.toHex() };
}

/** Install a contract WASM to Casper, returning the submitted deploy hash. */
export async function installContract(opts: InstallOptions): Promise<InstallResult> {
  const { deploy, account } = buildInstallDeploy(opts);
  if (!deploy.validate()) throw new Error("install deploy failed self-validation");
  const rpc = new RpcClient(new HttpHandler(opts.nodeAddress));
  await rpc.putDeploy(deploy);
  return { deployHash: deploy.hash.toHex(), account };
}

interface NamedKey {
  name: string;
  key: string;
}

/**
 * Resolve an installed contract's hash from the deployer account's named keys
 * after the install deploy executes. Odra installers register a named key for
 * the package/contract; we look it up by convention (`<name>_package_hash` /
 * `<name>_contract_hash`), falling back to a contains-match.
 *
 * Uses the dependency-free raw JSON-RPC read path ({@link CasperRpcClient}) so it
 * stays robust against SDK type churn and consistent with the rest of reads.
 */
export async function resolveContractHash(
  nodeAddress: string,
  accountHex: string,
  namedKeyHints: string[],
): Promise<string | null> {
  const rpc = new CasperRpcClient({ nodeAddress });
  // Casper 1.x exposes account named keys via state_get_account_info; 2.x via the
  // addressable-entity query. Try the legacy shape first, then the entity shape.
  const namedKeys = await readNamedKeys(rpc, accountHex);
  if (!namedKeys.length) return null;
  for (const hint of namedKeyHints) {
    const exact = namedKeys.find((k) => k.name === hint);
    if (exact) return exact.key;
  }
  for (const hint of namedKeyHints) {
    const partial = namedKeys.find((k) => k.name.includes(hint));
    if (partial) return partial.key;
  }
  return null;
}

async function readNamedKeys(rpc: CasperRpcClient, accountHex: string): Promise<NamedKey[]> {
  try {
    const r = await rpc.call<{ account?: { named_keys?: NamedKey[] } }>("state_get_account_info", {
      public_key: accountHex,
    });
    if (r.account?.named_keys?.length) return r.account.named_keys;
  } catch {
    // fall through to the addressable-entity query (Casper 2.0)
  }
  try {
    const r = await rpc.call<{ entity?: { named_keys?: NamedKey[] } }>("state_get_entity", {
      entity_identifier: { PublicKey: accountHex },
    });
    if (r.entity?.named_keys?.length) return r.entity.named_keys;
  } catch {
    // no named keys resolvable
  }
  return [];
}
