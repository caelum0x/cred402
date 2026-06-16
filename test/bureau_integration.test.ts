import { test } from "node:test";
import assert from "node:assert/strict";

import { Cred402Economy } from "../agents/economy.js";
import { Ledger } from "../lib/ledger/index.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { AttestationGraph } from "../lib/services/attestation_graph.js";
import { CreditOffers } from "../lib/services/credit_offers.js";
import { discoverAgents } from "../lib/services/discovery.js";
import { buildCreditHistory } from "../lib/services/credit_history.js";
import { buildRiskAlerts } from "../lib/services/risk_alerts.js";
import { buildYieldProjection } from "../lib/services/yield_projection.js";
import { buildOnboardingScorecard } from "../lib/services/onboarding_scorecard.js";
import { buildPortfolioReport } from "../lib/services/portfolio.js";

/**
 * End-to-end bureau lifecycle: the new services must compose over one shared ledger
 * — an agent earns, qualifies, is pre-approved, draws credit, and every analytics
 * surface reflects the same canonical state.
 */
test("bureau: offer → accept → draw flows through history, portfolio, risk, yield, readiness", async () => {
  const econ = new Cred402Economy(new Ledger());
  econ.bootstrap();
  econ.createJob();
  const { reports } = await econ.runEvidencePurchases();
  await econ.runWatchdogAudit(reports);
  const ledger = econ.ledger;
  const agentId = econ.seller.agent_id;

  // LPs fund the pool so a line can actually be drawn.
  econ.ledger.pool.deposit_liquidity(econ.ledger.pool.poolState().total_liquidity === 0n ? 1_000_000_000_000n : 1_000_000_000n, "lp-int");

  // 1. The agent should be ready for credit.
  const readiness = buildOnboardingScorecard(ledger, agentId);
  assert.ok(!("error" in readiness));
  if ("error" in readiness) return;
  assert.equal(readiness.ready, true);

  // 2. Issue and accept a pre-approval offer → opens a real line.
  const offers = new CreditOffers(ledger, econ.credit);
  const offer = offers.issue(agentId);
  assert.ok(!("error" in offer));
  if ("error" in offer) return;
  const accepted = offers.accept(offer.offer_id);
  assert.ok(!("error" in accepted));
  const line = ledger.pool.get(agentId);
  assert.ok(line, "a line should exist after accepting the offer");

  // 3. Draw against the line.
  const drawAmount = line!.max_credit > 0n ? line!.max_credit / 2n : 0n;
  if (drawAmount > 0n) ledger.pool.draw(agentId, drawAmount);

  // 4. Credit history reflects the lifecycle (registration + credit events).
  const history = buildCreditHistory(ledger, agentId);
  if ("error" in history) return assert.fail("expected history");
  assert.ok(history.entries.length > 0);
  assert.ok(history.counts.credit >= 1, "credit events should appear in the file");

  // 5. Portfolio + yield reflect the outstanding draw.
  if (drawAmount > 0n) {
    const portfolio = buildPortfolioReport(ledger);
    assert.equal(portfolio.outstanding_motes, drawAmount.toString());
    assert.ok(portfolio.by_agent.some((s) => s.key === agentId));

    const yieldProj = buildYieldProjection(ledger, new ProtocolEconomics());
    const annual = yieldProj.horizons.find((h) => h.horizon_days === 365)!;
    assert.ok(Number(annual.gross_interest_motes) > 0, "a drawn book should project interest");
  }

  // 6. Risk alerts include the single-borrower concentration warning.
  if (drawAmount > 0n) {
    const alerts = buildRiskAlerts(ledger);
    assert.ok(alerts.alerts.some((a) => a.code === "concentration_high"));
  }

  // 7. Discovery ranks the agent within its cohort.
  const discovery = discoverAgents(ledger, new AttestationGraph(ledger), {});
  assert.ok(discovery.results.some((r) => r.agent_id === agentId));
});
