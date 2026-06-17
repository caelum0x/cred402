/**
 * universal_credit_demo.ts (roadmap p1) — Cred402 underwrites ANY x402 service,
 * not just RWA. An inference API agent earns x402 revenue and gets a credit line
 * from its receipts alone — no RWA evidence — weighted by its service category.
 *
 *   npm run demo:x402
 */
import { Ledger } from "../lib/ledger/ledger.js";
import { Cred402Economy } from "../agents/index.js";
import { policyV1 } from "../lib/core/risk_policy.js";
import { cspr, formatCspr as fmtCspr } from "../lib/core/units.js";

const econ = new Cred402Economy(new Ledger());
const reg = econ.ledger.serviceCategories;

console.log("\n● Service Category Registry — Cred402 underwrites the whole x402 economy");
for (const fam of ["rwa", "data", "inference", "compute", "defi"]) {
  const sample = reg.list().find((c) => c.family === fam);
  if (sample) console.log(`  ${fam.padEnd(10)} risk weight x${(sample.risk_bps / 10000).toFixed(2)}  (e.g. ${sample.category})`);
}

console.log("\n● A non-RWA agent earns x402 revenue (inference.llm) — no RWA evidence");
econ.ledger.agents.register_agent({
  agent_id: "InferenceAgent",
  owner_public_key: "01aa",
  agent_public_key: "01bb",
  service_type: "inference.llm",
});
econ.ledger.agents.stake("InferenceAgent", cspr(60));
const now = econ.ledger.clock.now();
for (let i = 0; i < 24; i++) {
  econ.ledger.agents.record_job(
    "InferenceAgent",
    { receipt_id: `inf-${i}`, amount: cspr(3), timestamp: now - i * 86400, service_type: "inference.llm" },
    95,
    false,
  );
}
econ.ledger.agents.update_reputation("InferenceAgent", 86, "0x", "FINALIZED_X402_REVENUE");

const r = econ.credit.underwrite("InferenceAgent");
console.log(`  30d x402 revenue: ${fmtCspr(r.decision.last_30_day_revenue)}`);
console.log(`  credit score:     ${r.decision.credit_score}/100`);
console.log(`  credit line:      ${fmtCspr(r.line.max_credit)}`);
console.log(`  RWA evidence:     ${econ.ledger.evidence.list().filter((e) => e.agent_id === "InferenceAgent").length} (none needed)`);
console.log("  reasons: " + r.decision.rationale.filter((x) => /category|revenue|stake/.test(x)).join(" · "));

console.log("\n● Same receipts, different category → category risk weight scales the line");
const base = (svc: string) => ({
  agent_id: "x", owner_public_key: "01", agent_public_key: "01", service_type: svc,
  stake: cspr(60), total_jobs_completed: 300,
  x402_revenue_history: Array.from({ length: 24 }, (_, i) => ({ receipt_id: `r${i}`, amount: cspr(3), timestamp: now - i * 86400, service_type: svc })),
  accuracy_score: 95, dispute_rate: 0.01, reputation_score: 86, credit_score: 0, current_credit_line: 0n, active: true, registered_at: now,
});
for (const svc of ["rwa.weather_risk", "compliance.kyb_check", "inference.llm", "defi.yield_routing"]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  console.log(`  ${svc.padEnd(24)} -> credit line ${fmtCspr(policyV1(base(svc) as any, now).credit_line)}`);
}
console.log("\nAgents earn anywhere. Casper decides who is creditworthy — for every x402 service.\n");
