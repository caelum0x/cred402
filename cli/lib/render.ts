/**
 * Dependency-free terminal rendering: ANSI colors, aligned tables, CSPR
 * formatting, status badges, and reason-code chips. No external packages —
 * everything is hand-rolled so the CLI runs under `npx tsx` with zero installs.
 */

const ESC = "\x1b[";
const useColor = (): boolean => process.env.NO_COLOR === undefined && process.stdout.isTTY !== false;

type Style = (s: string) => string;

const wrap =
  (open: number, close: number): Style =>
  (s: string): string =>
    useColor() ? `${ESC}${open}m${s}${ESC}${close}m` : s;

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
} as const;

/** Visible width of a string, ignoring ANSI escape sequences. */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function pad(s: string, width: number, align: "left" | "right"): string {
  const gap = Math.max(0, width - visibleWidth(s));
  const fill = " ".repeat(gap);
  return align === "right" ? fill + s : s + fill;
}

export interface Column {
  readonly header: string;
  readonly align?: "left" | "right";
}

/**
 * Render an aligned table. `rows` cells may contain ANSI color codes — widths
 * are computed on visible width so columns stay aligned.
 */
export function table(columns: readonly Column[], rows: readonly (readonly string[])[]): string {
  const widths = columns.map((c, i) => {
    const cells = rows.map((r) => visibleWidth(r[i] ?? ""));
    return Math.max(visibleWidth(c.header), ...(cells.length ? cells : [0]));
  });

  const renderRow = (cells: readonly string[], styler?: Style): string =>
    columns
      .map((c, i) => {
        const cell = pad(cells[i] ?? "", widths[i] ?? 0, c.align ?? "left");
        return styler ? styler(cell) : cell;
      })
      .join("  ");

  const head = renderRow(
    columns.map((c) => c.header),
    color.bold,
  );
  const sep = color.gray(widths.map((w) => "─".repeat(w)).join("  "));
  const body = rows.map((r) => renderRow(r)).join("\n");
  return rows.length ? `${head}\n${sep}\n${body}` : `${head}\n${sep}\n${color.dim("(no rows)")}`;
}

/** Render a two-column key/value block with aligned keys. */
export function keyValues(pairs: readonly (readonly [string, string])[]): string {
  const keyWidth = Math.max(0, ...pairs.map(([k]) => k.length));
  return pairs
    .map(([k, v]) => `${color.gray(pad(k, keyWidth, "left"))}  ${v}`)
    .join("\n");
}

/** Section heading with a leading rule. */
export function heading(title: string): string {
  return `\n${color.bold(color.cyan(title))}`;
}

const MOTES_PER_CSPR = 1_000_000_000n;

/**
 * Format an integer motes string/bigint as a human CSPR amount.
 * 1 CSPR = 1e9 motes. Trailing zeros are trimmed; grouping added to the integer part.
 */
export function formatCspr(motes: string | number | bigint, opts: { suffix?: boolean } = {}): string {
  let v: bigint;
  try {
    v = typeof motes === "bigint" ? motes : BigInt(String(motes).split(".")[0] ?? "0");
  } catch {
    return String(motes);
  }
  const negative = v < 0n;
  if (negative) v = -v;
  const whole = v / MOTES_PER_CSPR;
  const frac = v % MOTES_PER_CSPR;
  const wholeStr = group(whole.toString());
  let out: string;
  if (frac === 0n) {
    out = wholeStr;
  } else {
    const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
    out = `${wholeStr}.${fracStr}`;
  }
  const signed = negative ? `-${out}` : out;
  return opts.suffix === false ? signed : `${signed} CSPR`;
}

/** Add thousands separators to an integer string. */
function group(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Format basis points as a percentage, e.g. 898 -> "8.98%". */
export function formatBps(bps: number | string): string {
  const n = typeof bps === "number" ? bps : Number(bps);
  if (!Number.isFinite(n)) return String(bps);
  return `${(n / 100).toFixed(2)}%`;
}

/** Format a 0..1 ratio as a percentage. */
export function formatRatio(ratio: number, digits = 1): string {
  if (!Number.isFinite(ratio)) return String(ratio);
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** Color a status string: active=green, frozen/defaulted/denied=red, else yellow. */
export function statusBadge(status: string): string {
  const s = status.toLowerCase();
  if (["active", "verified", "cleared", "ok", "passed", "approved", "true", "open"].includes(s)) {
    return color.green(status);
  }
  if (["frozen", "defaulted", "denied", "rejected", "failed", "false", "closed", "denylisted"].includes(s)) {
    return color.red(status);
  }
  return color.yellow(status);
}

export type Polarity = "positive" | "negative" | "neutral";

/** A reason-code chip: +green for positive, −red for negative. */
export function reasonChip(code: string, polarity: Polarity): string {
  if (polarity === "positive") return color.green(`+${code}`);
  if (polarity === "negative") return color.red(`−${code}`);
  return color.gray(`~${code}`);
}

/** Render an Unix timestamp (seconds) as an ISO-ish date, or "—" if absent. */
export function formatTimestamp(ts: number | string | undefined): string {
  if (ts === undefined || ts === null || ts === "") return "—";
  const n = typeof ts === "number" ? ts : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "—";
  // values look like Unix seconds; some are ms (>1e12)
  const ms = n > 1e12 ? n : n * 1000;
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** A simple success / error line prefix. */
export const sym = {
  ok: () => color.green("✔"),
  err: () => color.red("✖"),
  info: () => color.blue("ℹ"),
  arrow: () => color.gray("→"),
} as const;

/** Pretty-print JSON for `--json` mode. */
export function asJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
