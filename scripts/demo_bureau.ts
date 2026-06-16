/**
 * demo_bureau.ts — a narrated walk through the Cred402 credit-bureau lifecycle
 * against a live server. Exercises the full arc for one agent: readiness → what-if
 * → pre-approval offer → accept → draw cost → health → benchmark → compare →
 * trend → multichain, then the protocol-level analytics. Living documentation that
 * doubles as an end-to-end smoke test.
 *
 *   npm start              # in one terminal
 *   npm run demo:bureau    # in another
 */
export {};

const API = process.env.CRED402_API ?? "http://localhost:4021";

async function get(path: string): Promise<any> {
  const r = await fetch(`${API}${path}`);
  const j = (await r.json()) as any;
  return j.data ?? j;
}
async function post(path: string, body: unknown = {}): Promise<any> {
  const r = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as any;
  return j.data ?? j;
}

const cspr = (motes: string | number) => `${(Number(motes) / 1e9).toLocaleString(undefined, { maximumFractionDigits: 4 })} CSPR`;
const line = (label: string, value: string) => console.log(`  ${label.padEnd(22)} ${value}`);
const head = (n: number, title: string) => console.log(`\n\x1b[36m${n}. ${title}\x1b[0m`);

async function main(): Promise<void> {
  console.log(`\n◆ Cred402 bureau demo — ${API}`);
  await post("/api/demo/run");
  await fetch(`${API}/api/demo/multichain`, { method: "POST" }).catch(() => undefined);
  // Register a peer so the comparison step has two agents to weigh.
  await post("/v1/agents", { agent_id: "WeatherRiskAgent", service_type: "weather_risk" });
  const agent = "EvidenceSellerAgent";

  head(1, `Onboarding readiness — ${agent}`);
  const readiness = await get(`/v1/agents/${agent}/readiness`);
  line("ready", `${readiness.ready} (${readiness.readiness_pct}%)`);
  for (const i of readiness.items.filter((x: any) => !x.met)) line("  unmet", `${i.requirement} — ${i.guidance}`);

  head(2, "What-if underwriting (read-only)");
  const sim = await post("/v1/credit/simulate", { monthly_revenue_cspr: 8000, reputation: 90, stake_cspr: 100 });
  line("estimated line", `${sim.estimated_credit_line_cspr} CSPR @ ${(sim.decision.interest_rate_bps / 100).toFixed(1)}%`);

  head(3, "Pre-approval offer → accept → open a line");
  const offer = await post("/v1/credit/offers", { agent_id: agent });
  if (offer.error) { line("offer", `skipped (${offer.error})`); }
  else {
    line("offer", `${offer.offer_id} · up to ${cspr(offer.max_credit_motes)}`);
    const accepted = await post(`/v1/credit/offers/${offer.offer_id}/accept`);
    line("accepted", accepted.error ? accepted.error : `line opened at ${cspr(accepted.offer.max_credit_motes)}`);
  }

  head(4, "Cost of a 3 CSPR draw");
  const cost = await get(`/v1/agents/${agent}/credit-cost?draw_cspr=3`);
  if (!cost.error) {
    line("origination", cspr(cost.origination_fee_motes));
    line("interest (term)", cspr(cost.interest_estimate_motes));
    line("all-in cost", `${cspr(cost.all_in_cost_motes)} (${cost.effective_cost_pct}%)`);
  }

  head(5, "Health, benchmark & comparison");
  const health = await get(`/v1/agents/${agent}/health`);
  line("health", `${health.status} (score ${health.score})`);
  const bench = await get(`/v1/agents/${agent}/benchmark`);
  line("benchmark", `${bench.overall_percentile}th percentile in ${bench.service_type}`);
  const cmp = await get(`/v1/agents/compare?a=${agent}&b=WeatherRiskAgent`);
  line("vs WeatherRisk", cmp.summary ?? "n/a");

  head(6, "Reputation trend & cross-chain footprint");
  const trend = await get(`/v1/agents/${agent}/score-trend`);
  line("reputation", `${trend.reputation.current} (${trend.reputation.change >= 0 ? "+" : ""}${trend.reputation.change}) [${trend.reputation.points.map((p: any) => p.value).join("→")}]`);
  const mc = await get(`/v1/agents/${agent}/multichain`);
  line("chains", mc.chains.map((c: any) => `${c.chain}(${c.credit_notes} CAN)`).join(", ") || "none");

  head(7, "Protocol analytics");
  const portfolio = await get("/v1/credit/portfolio");
  line("portfolio", `HHI ${portfolio.hhi} (${portfolio.concentration_band})`);
  const yield_ = await get("/v1/credit/yield-projection");
  line("LP yield (365d)", `${(yield_.horizons.find((h: any) => h.horizon_days === 365).projected_apy * 100).toFixed(2)}% APY`);
  const alerts = await get("/v1/risk/alerts");
  line("risk alerts", `${alerts.counts.critical} critical / ${alerts.counts.warning} warning`);
  const x402 = await get("/v1/analytics/x402");
  line("x402 network", `${x402.total_receipts} receipts · ${cspr(x402.total_volume_motes)}`);
  const cfg = await get("/v1/config");
  line("policy", `${cfg.policy_version} · origination ${cfg.fees.origination_fee_bps}bps · spread ${cfg.fees.interest_spread_bps}bps`);

  console.log("\n\x1b[32m✓ bureau lifecycle complete\x1b[0m\n");
}

main().catch((e) => {
  console.error("demo failed (is the server running?):", (e as Error).message);
  process.exit(1);
});
