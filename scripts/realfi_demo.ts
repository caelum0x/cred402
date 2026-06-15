/**
 * realfi_demo.ts — p6 Cred402 RealFi Bridge end to end.
 *
 * An agent with a real, Stripe-verified operator and fiat billing earns a higher
 * credit line than an anonymous one — without any PII touching the chain. Then a
 * chargeback cuts the line back. Casper-native receipts still dominate the score.
 *
 *   npm run demo:realfi
 */
import { Ledger } from "../lib/ledger/index.js";
import { Cred402Economy } from "../agents/economy.js";
import { formatCspr } from "../lib/core/units.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import { banner, scene } from "./render.js";

async function main(): Promise<void> {
  const ledger = new Ledger();
  const econ = new Cred402Economy(ledger);
  econ.bootstrap();
  econ.createJob();
  await econ.runEvidencePurchases();
  econ.scoreJob();
  const seller = econ.seller.agent_id;
  const operatorId = "operator:0xA17solarspv";
  ledger.passports.set_profile(seller, { operator: operatorId });

  const bridge = new RealFiBridge(ledger);
  banner("Cred402 RealFi Bridge — fiat finance, no PII on-chain");

  // Baseline: anonymous operator.
  const base = econ.credit.underwrite(seller);
  scene({
    scene: "Baseline credit line (no RealFi)",
    lines: [
      `credit line: ${formatCspr(base.line.max_credit)} CSPR`,
      `realfi reason codes: ${codes(base.decision, ["VERIFIED_OPERATOR", "UNVERIFIED_OPERATOR", "FIAT_REVENUE", "CHARGEBACK_PENALTY"])}`,
    ],
  });

  // Verify the operator via Stripe Identity + record settled Stripe billing + Plaid cashflow.
  bridge.verifyOperator({
    operator_id: operatorId,
    verification_level: "business_verified",
    jurisdiction: "TR",
    verification_reference: "stripe_idv_secret_ref_abc123",
  });
  for (let i = 0; i < 4; i++) {
    bridge.recordFiatReceipt({
      provider_event_id: `evt_${i}`,
      provider_receipt_id: `ch_${i}`,
      payer_type: "enterprise_customer",
      seller_agent: seller,
      operator_id: operatorId,
      amount: "100.00",
      currency: "USD",
      service_type: "rwa.weather_risk",
      request_hash: "0xreq",
      result_hash: "0xres",
    });
  }
  bridge.recordBankVerification({
    operator_id: operatorId,
    account_ownership_verified: true,
    cashflow_report: { monthly_inflow_usd: 9800, months: 12 },
    balance_snapshot: { usd: 24000 },
    data_period_start: ledger.clock.now() - 31_536_000,
    data_period_end: ledger.clock.now(),
  });

  const verified = econ.credit.underwrite(seller);
  scene({
    scene: "After RealFi verification (Stripe Identity + billing + Plaid)",
    lines: [
      `operator verified: ${ledger.operators.is_verified(operatorId)} (level business_verified, jurisdiction TR)`,
      `on-chain fiat receipts: ${ledger.fiatReceipts.forSeller(seller).length} (hashes only — zero PII)`,
      `credit line: ${formatCspr(verified.line.max_credit)} CSPR (was ${formatCspr(base.line.max_credit)})`,
      `realfi reason codes: ${codes(verified.decision, ["VERIFIED_OPERATOR", "FIAT_REVENUE", "BANK_CASHFLOW_VERIFIED"])}`,
    ],
  });

  // A Stripe chargeback arrives — the line is cut.
  bridge.recordChargeback({ operator_id: operatorId, dispute_reference: "dp_0xbad" });
  const afterChargeback = econ.credit.underwrite(seller);
  scene({
    scene: "Stripe chargeback → credit line cut",
    lines: [
      `credit line: ${formatCspr(afterChargeback.line.max_credit)} CSPR (was ${formatCspr(verified.line.max_credit)})`,
      `realfi reason codes: ${codes(afterChargeback.decision, ["CHARGEBACK_PENALTY", "VERIFIED_OPERATOR"])}`,
    ],
  });

  banner("Fiat is a supplement. Casper-native receipts remain the foundation.");
}

function codes(decision: { reason_codes?: { code: string }[] }, wanted: string[]): string {
  const present = new Set((decision.reason_codes ?? []).map((c) => c.code));
  return wanted.filter((c) => present.has(c)).join(", ") || "none";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
