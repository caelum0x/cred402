/**
 * status.ts — "cred402 doctor": probe every live surface and report health.
 *
 *   npm run status                 (against a running server)
 *   CRED402_API=http://host npm run status
 */
export {}; // module scope

const API = process.env.CRED402_API ?? "http://localhost:4021";

interface Check {
  name: string;
  run: () => Promise<string>;
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

const checks: Check[] = [
  { name: "REST /v1/health", run: async () => `policy ${(await getJson("/v1/health") as { data?: { policy?: string } }).data?.policy}` },
  { name: "console /api/state", run: async () => `${Object.keys((await getJson("/api/state") as { contractHashes?: object }).contractHashes ?? {}).length} contracts` },
  { name: "analytics", run: async () => `${(await getJson("/api/analytics") as { totals?: { agents?: number } }).totals?.agents} agents` },
  { name: "timeseries", run: async () => `${((await getJson("/api/timeseries")) as unknown[]).length} points` },
  { name: "notifications", run: async () => `${((await getJson("/api/notifications")) as unknown[]).length} alerts` },
  {
    name: "graphql",
    run: async () => {
      const res = await fetch(`${API}/graphql`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ agents { agent_id } }" }) });
      const j = (await res.json()) as { data?: { agents?: unknown[] } };
      return `${j.data?.agents?.length ?? 0} agents`;
    },
  },
  {
    name: "prometheus /metrics",
    run: async () => {
      const res = await fetch(`${API}/metrics`);
      const text = await res.text();
      return `${text.split("\n").filter((l) => l.startsWith("cred402_")).length} series`;
    },
  },
  {
    name: "x402 402 challenge",
    run: async () => {
      const res = await fetch(`${API}/verify/energy_output?rwa_id=SOLAR-A17`);
      return `HTTP ${res.status} ${res.headers.get("x-payment-network") ?? ""}`;
    },
  },
  { name: "credit report", run: async () => `score ${(await getJson("/api/credit-report/EvidenceSellerAgent") as { credit_score?: number }).credit_score}` },
  {
    name: "public report HTML",
    run: async () => {
      const res = await fetch(`${API}/report/EvidenceSellerAgent`);
      return `HTTP ${res.status} ${res.headers.get("content-type")?.split(";")[0] ?? ""}`;
    },
  },
  {
    name: "csv export",
    run: async () => {
      const res = await fetch(`${API}/api/export/agents.csv`);
      return `${(await res.text()).split("\n").length - 2} rows`;
    },
  },
  {
    name: "graphiql explorer",
    run: async () => {
      const res = await fetch(`${API}/graphiql`);
      return `HTTP ${res.status}`;
    },
  },
  { name: "bureau: discovery", run: async () => `${(await getJson("/v1/discovery") as { data?: { count?: number } }).data?.count} ranked` },
  { name: "bureau: portfolio", run: async () => `HHI ${(await getJson("/v1/credit/portfolio") as { data?: { hhi?: number } }).data?.hhi}` },
  { name: "bureau: risk alerts", run: async () => `${((await getJson("/v1/risk/alerts") as { data?: { alerts?: unknown[] } }).data?.alerts ?? []).length} alerts` },
  { name: "bureau: yield projection", run: async () => `${(await getJson("/v1/credit/yield-projection") as { data?: { weighted_avg_apr_bps?: number } }).data?.weighted_avg_apr_bps} bps wavg APR` },
  { name: "bureau: readiness", run: async () => `${(await getJson("/v1/agents/EvidenceSellerAgent/readiness") as { data?: { readiness_pct?: number } }).data?.readiness_pct}% ready` },
];

async function main(): Promise<void> {
  console.log(`\nCred402 status — ${API}\n`);
  let ok = 0;
  for (const c of checks) {
    try {
      const detail = await c.run();
      console.log(`  \x1b[32m✓\x1b[0m ${c.name.padEnd(24)} ${detail}`);
      ok++;
    } catch (err) {
      console.log(`  \x1b[31m✗\x1b[0m ${c.name.padEnd(24)} ${(err as Error).message}`);
    }
  }
  console.log(`\n${ok}/${checks.length} surfaces healthy\n`);
  if (ok < checks.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
