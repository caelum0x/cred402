import type { Ledger } from "../ledger/ledger.js";

/**
 * Prometheus metrics exposition (production observability).
 *
 * Renders the live protocol state as Prometheus text-format metrics so Grafana /
 * Alertmanager can scrape `/metrics`: pool health, agent/receipt counts, dispute
 * and default gauges, x402 volume, and a per-event-type counter from the journal.
 * Pure read over the ledger — no extra state to keep in sync.
 */

interface Metric {
  name: string;
  help: string;
  type: "gauge" | "counter";
  value: number;
  labels?: Record<string, string>;
}

function line(m: Metric): string {
  const labels = m.labels
    ? "{" + Object.entries(m.labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",") + "}"
    : "";
  return `${m.name}${labels} ${m.value}`;
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

const MOTES = 1e9;

export function renderMetrics(ledger: Ledger): string {
  const agents = ledger.agents.list();
  const receipts = ledger.receipts.list();
  const pool = ledger.pool.poolState();
  const lines = ledger.pool.list();
  const disputes = ledger.disputes.list();
  const events = ledger.bus.all();

  const x402Volume = receipts.reduce((s, r) => s + r.amount, 0n);
  const utilization = Number(pool.total_liquidity) > 0 ? Number(pool.outstanding_credit) / Number(pool.total_liquidity) : 0;
  const openDisputes = disputes.filter((d) => d.status !== "resolved" && d.status !== "closed").length;

  // Per-event-type counts from the journal.
  const byEvent = new Map<string, number>();
  for (const e of events) byEvent.set(e.name, (byEvent.get(e.name) ?? 0) + 1);

  const out: string[] = [];
  const emit = (m: Metric) => out.push(line(m));
  const header = (name: string, help: string, type: "gauge" | "counter") => {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
  };

  header("cred402_agents_total", "Registered agents", "gauge");
  emit({ name: "cred402_agents_total", help: "", type: "gauge", value: agents.length });

  header("cred402_receipts_total", "x402 receipts recorded", "gauge");
  emit({ name: "cred402_receipts_total", help: "", type: "gauge", value: receipts.length });

  header("cred402_pool_liquidity_cspr", "Total pool liquidity (CSPR)", "gauge");
  emit({ name: "cred402_pool_liquidity_cspr", help: "", type: "gauge", value: Number(pool.total_liquidity) / MOTES });

  header("cred402_pool_outstanding_cspr", "Outstanding credit (CSPR)", "gauge");
  emit({ name: "cred402_pool_outstanding_cspr", help: "", type: "gauge", value: Number(pool.outstanding_credit) / MOTES });

  header("cred402_pool_utilization_ratio", "Pool utilization 0..1", "gauge");
  emit({ name: "cred402_pool_utilization_ratio", help: "", type: "gauge", value: round(utilization) });

  header("cred402_credit_lines_open", "Open credit lines", "gauge");
  emit({ name: "cred402_credit_lines_open", help: "", type: "gauge", value: lines.length });

  header("cred402_disputes_open", "Open disputes", "gauge");
  emit({ name: "cred402_disputes_open", help: "", type: "gauge", value: openDisputes });

  header("cred402_defaults_total", "Credit defaults", "counter");
  emit({ name: "cred402_defaults_total", help: "", type: "counter", value: pool.defaults });

  header("cred402_x402_volume_cspr", "Total x402 settled volume (CSPR)", "counter");
  emit({ name: "cred402_x402_volume_cspr", help: "", type: "counter", value: Number(x402Volume) / MOTES });

  header("cred402_events_total", "Protocol events emitted, by type", "counter");
  for (const [name, count] of [...byEvent.entries()].sort()) {
    emit({ name: "cred402_events_total", help: "", type: "counter", value: count, labels: { event: name } });
  }

  return out.join("\n") + "\n";
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
