/**
 * CSPR / motes helpers.
 *
 * Casper denominates value in "motes": 1 CSPR = 1_000_000_000 motes.
 * On-chain amounts are U512 (unbounded). In this reference implementation we use
 * the native JS `bigint` to model U512 and keep all arithmetic in integer motes,
 * exactly as a real Casper contract would.
 */

export const MOTES_PER_CSPR = 1_000_000_000n;

/** Convert a CSPR amount (may be fractional) to integer motes. */
export function cspr(amount: number | string): bigint {
  const s = typeof amount === "number" ? amount.toString() : amount.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid CSPR amount: ${s}`);
  }
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = s.replace("-", "").split(".");
  const fracPadded = (frac + "000000000").slice(0, 9);
  const motes = BigInt(whole || "0") * MOTES_PER_CSPR + BigInt(fracPadded || "0");
  return negative ? -motes : motes;
}

/** Format integer motes back to a human CSPR string (trimmed). */
export function formatCspr(motes: bigint, decimals = 4): string {
  const negative = motes < 0n;
  const abs = negative ? -motes : motes;
  const whole = abs / MOTES_PER_CSPR;
  const frac = abs % MOTES_PER_CSPR;
  const fracStr = frac.toString().padStart(9, "0").slice(0, decimals).replace(/0+$/, "");
  const out = fracStr ? `${whole}.${fracStr}` : `${whole}`;
  return negative ? `-${out}` : out;
}

/** Multiply a motes value by a floating ratio, returning integer motes (floored). */
export function scaleMotes(motes: bigint, ratio: number): bigint {
  // Scale through a fixed-point of 1e9 to preserve precision without floats on bigint.
  const scaled = Math.round(ratio * 1e9);
  return (motes * BigInt(scaled)) / 1_000_000_000n;
}

/** Basis points helper: applies `bps`/10000 to motes. */
export function applyBps(motes: bigint, bps: bigint): bigint {
  return (motes * bps) / 10_000n;
}

/** JSON-safe serialization for bigint motes used by the API layer. */
export function motesToString(motes: bigint): string {
  return motes.toString();
}
