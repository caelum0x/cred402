/**
 * Typed Casper runtime arguments (the inputs to a contract entry point).
 *
 * A dependency-free, serializable representation of CLValues. casper-js-sdk turns
 * these into the exact CL byte encoding at submit time; keeping the typed spec
 * here means the contract-call shape is defined and testable without the SDK.
 */

export type CLType = "String" | "Bool" | "U64" | "U512" | "Key" | "PublicKey" | "ByteArray";

export interface RuntimeArg {
  name: string;
  clType: CLType;
  value: string; // canonical string form (bigints as decimal, keys as hex)
}

export const arg = {
  string(name: string, value: string): RuntimeArg {
    return { name, clType: "String", value };
  },
  bool(name: string, value: boolean): RuntimeArg {
    return { name, clType: "Bool", value: value ? "true" : "false" };
  },
  u64(name: string, value: number | bigint): RuntimeArg {
    return { name, clType: "U64", value: BigInt(value).toString() };
  },
  u512(name: string, motes: bigint): RuntimeArg {
    if (motes < 0n) throw new Error("U512 cannot be negative");
    return { name, clType: "U512", value: motes.toString() };
  },
  key(name: string, hashHex: string): RuntimeArg {
    return { name, clType: "Key", value: normalizeHex(hashHex) };
  },
  publicKey(name: string, pubKeyHex: string): RuntimeArg {
    return { name, clType: "PublicKey", value: normalizeHex(pubKeyHex) };
  },
};

function normalizeHex(h: string): string {
  const x = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^[0-9a-fA-F]*$/.test(x)) throw new Error(`invalid hex: ${h}`);
  return x.toLowerCase();
}

/** Render args as `casper-client`'s `--session-arg "name:type='value'"` flags. */
export function toCasperClientArgs(args: RuntimeArg[]): string[] {
  return args.map((a) => {
    const t = a.clType.toLowerCase();
    return `--session-arg "${a.name}:${t}='${a.value}'"`;
  });
}
