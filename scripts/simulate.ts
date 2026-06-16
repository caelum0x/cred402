/**
 * simulate.ts — drive the live Cred402 API to build a rich dataset: seed the core
 * loop, register a fleet of agents, verify operators, record fiat receipts, run
 * x402 purchases, and open a dispute. Populates Analytics, Ops, Explorer, RealFi.
 *
 *   npm run simulate            (against a running server)
 *   CRED402_API=http://host npm run simulate
 */
export {};

const API = process.env.CRED402_API ?? "http://localhost:4021";

async function post(path: string, body: unknown = {}): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
}
async function get(path: string): Promise<unknown> {
  return (await fetch(`${API}${path}`)).json();
}

const FLEET = [
  { id: "WeatherRiskAgent", svc: "weather_risk", jur: "US" },
  { id: "ReceivableAgent", svc: "receivable_quality", jur: "DE" },
  { id: "CollateralMonitor", svc: "monitoring", jur: "GB" },
  { id: "TreasuryRouter", svc: "treasury_routing", jur: "SG" },
  { id: "RiskScorer", svc: "risk_scoring", jur: "FR" },
];

async function main(): Promise<void> {
  console.log(`Simulating against ${API}\n`);
  await post("/api/demo/run");
  console.log("✓ seeded core loop");

  for (const a of FLEET) {
    const reg = (await post("/v1/agents", { agent_id: a.id, service_type: a.svc })) as { success?: boolean };
    const operatorId = `operator:${a.id.toLowerCase()}`;
    await post("/v1/realfi/operators", { operator_id: operatorId, verification_level: "business_verified", jurisdiction: a.jur, verification_reference: `kyb-${a.id}` });
    await post("/v1/realfi/fiat-receipts", { seller_agent: a.id, operator_id: operatorId, amount: "250.00", currency: "USD", provider_event_id: `evt-${a.id}`, provider_receipt_id: `ch-${a.id}` });
    console.log(`✓ registered ${a.id} (${a.svc}, ${a.jur}) ${reg.success ? "+ operator + fiat receipt" : "[exists]"}`);
  }

  // A few x402 purchases to drive throughput + reputation.
  for (const t of ["energy_output", "weather_risk", "receivable_quality"]) {
    await post("/api/x402/buy", { evidence_type: t });
  }
  console.log("✓ ran 3 x402 purchases");

  // LPs add liquidity; an agent stakes to boost its capacity.
  await post("/api/credit/deposit", { amount_cspr: 500 });
  await post("/v1/agents/EvidenceSellerAgent/stake", { amount_cspr: 50 });
  console.log("✓ deposited 500 CSPR liquidity + staked 50 CSPR");

  // Agents list services, then trade with each other (the flywheel).
  for (const a of FLEET.slice(0, 3)) {
    const r = (await post("/v1/marketplace/listings", { agent_id: a.id, category: a.svc === "weather_risk" ? "rwa.weather_risk" : "rwa.invoice_validity", strategy: "reputation_tiered", base_price_cspr: 0.003 })) as { data?: { listing_id?: string } };
    const lid = r.data?.listing_id;
    if (lid) await post("/api/marketplace/purchase", { listing_id: lid, buyer_agent: "EvidenceSellerAgent" });
  }
  console.log("✓ agents listed services + traded with each other");

  // Web of trust: established agents vouch for newer ones (anti-Sybil capped boost).
  const vouches = [
    { from: "EvidenceSellerAgent", to: "WeatherRiskAgent", note: "reliable weather oracle" },
    { from: "EvidenceSellerAgent", to: "ReceivableAgent", note: "clean invoice history" },
    { from: "WeatherRiskAgent", to: "CollateralMonitor", note: "accurate monitoring" },
  ];
  let vouched = 0;
  for (const v of vouches) {
    const r = (await post("/v1/attestations", v)) as { data?: { error?: string } };
    if (!r.data?.error) vouched++;
  }
  console.log(`✓ issued ${vouched}/${vouches.length} trust attestations (web of trust)`);

  // Open a dispute and resolve it (full lifecycle).
  const dispute = (await post("/v1/disputes", { respondent_agent: "WeatherRiskAgent", dispute_type: "bad_evidence", note: "simulated dispute" })) as { data?: { dispute_id?: string } };
  if (dispute.data?.dispute_id) {
    await post(`/v1/disputes/${dispute.data.dispute_id}/verdict`, { verdict: "agent_loses", slash_cspr: 5 });
    console.log("✓ opened + resolved a dispute (agent_loses, slashed 5 CSPR)");
  }

  const a = (await get("/api/analytics")) as { totals?: { agents?: number; receipts?: number }; pool?: { utilization?: number } };
  const inc = (await get("/api/incidents")) as { open_disputes?: unknown[]; fraud_watchlist?: unknown[] };
  console.log(`\nDataset now: ${a.totals?.agents} agents, ${a.totals?.receipts} receipts, ${inc.open_disputes?.length} open disputes, ${inc.fraud_watchlist?.length} on fraud watchlist`);
}

main().catch((e) => {
  console.error("simulation failed (is the server running?):", (e as Error).message);
  process.exit(1);
});
