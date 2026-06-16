/**
 * CSV export — turn protocol read models into spreadsheet-ready CSV for analysts
 * and integrators. RFC 4180 quoting; bigints rendered as plain integers.
 */

export function toCsv(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return (columns ?? []).join(",") + "\n";
  const cols = columns ?? Object.keys(rows[0]!);
  const head = cols.map(quote).join(",");
  const body = rows.map((r) => cols.map((c) => quote(format(r[c]))).join(",")).join("\n");
  return head + "\n" + body + "\n";
}

function format(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function quote(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
