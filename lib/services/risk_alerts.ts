import type { Ledger } from "../ledger/ledger.js";
import { FraudService } from "./fraud_service.js";
import { buildPortfolioReport } from "./portfolio.js";

/**
 * Risk alerts — the bureau's always-on monitoring sweep. It scans the live pool,
 * credit lines and agent risk signals and emits actionable, severity-ranked alerts
 * a risk officer (or an automated guard) should act on: concentration breaches,
 * overdue lines, fraud exposure on open credit, frozen/defaulted lines, and
 * liquidity stress. Read-only and deterministic, so it is safe to poll.
 */

export type AlertSeverity = "critical" | "warning" | "info";

export interface RiskAlert {
  severity: AlertSeverity;
  code: string;
  subject: string; // the agent / pool the alert is about
  message: string;
}

export interface RiskAlertReport {
  generated_at: number;
  counts: Record<AlertSeverity, number>;
  alerts: RiskAlert[];
}

// Tunable thresholds (basis points / scores), kept here so the policy is explicit.
const HHI_CONCENTRATION = 2500; // > moderate
const UTILIZATION_STRESS_BPS = 9000; // 90%
const FRAUD_EXPOSURE_SCORE = 60; // open credit + fraud >= this is a red flag
const SEVERITY_RANK: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function buildRiskAlerts(ledger: Ledger): RiskAlertReport {
  const now = ledger.clock.now();
  const fraud = new FraudService(ledger);
  const portfolio = buildPortfolioReport(ledger);
  const lines = ledger.pool.list();
  const alerts: RiskAlert[] = [];

  // 1. Portfolio concentration.
  if (portfolio.hhi >= HHI_CONCENTRATION && Number(portfolio.outstanding_motes) > 0) {
    const top = portfolio.largest_borrower;
    alerts.push({
      severity: "warning",
      code: "concentration_high",
      subject: "pool",
      message: `Credit book is concentrated (HHI ${portfolio.hhi})${top ? `; largest borrower ${top.key} at ${(top.share_bps / 100).toFixed(0)}%` : ""}.`,
    });
  }

  // 2. Liquidity stress.
  if (portfolio.utilization_bps >= UTILIZATION_STRESS_BPS) {
    alerts.push({
      severity: "warning",
      code: "liquidity_stress",
      subject: "pool",
      message: `Pool utilization at ${(portfolio.utilization_bps / 100).toFixed(0)}% — limited free liquidity for new draws.`,
    });
  }

  // 3. Per-line conditions.
  for (const l of lines) {
    if (l.status === "defaulted") {
      alerts.push({ severity: "critical", code: "line_defaulted", subject: l.agent_id, message: `Credit line for ${l.agent_id} has defaulted.` });
    } else if (l.status === "frozen") {
      alerts.push({ severity: "warning", code: "line_frozen", subject: l.agent_id, message: `Credit line for ${l.agent_id} is frozen.` });
    }
    if (l.drawn > 0n && l.due_timestamp < now && l.status === "active") {
      const daysOverdue = Math.floor((now - l.due_timestamp) / 86_400);
      alerts.push({
        severity: "critical",
        code: "line_overdue",
        subject: l.agent_id,
        message: `${l.agent_id} is overdue by ${daysOverdue}d with an outstanding balance.`,
      });
    }
  }

  // 4. Fraud exposure on agents that currently hold credit.
  for (const l of lines) {
    if (l.drawn <= 0n) continue;
    const score = fraud.analyze(l.agent_id).score;
    if (score >= FRAUD_EXPOSURE_SCORE) {
      alerts.push({
        severity: "critical",
        code: "fraud_exposure",
        subject: l.agent_id,
        message: `${l.agent_id} holds drawn credit but has a fraud score of ${score}.`,
      });
    }
  }

  // 5. Open disputes against agents with credit.
  for (const l of lines) {
    if (ledger.disputes.openCount(l.agent_id) > 0 && l.drawn > 0n) {
      alerts.push({
        severity: "warning",
        code: "dispute_on_borrower",
        subject: l.agent_id,
        message: `${l.agent_id} has an open dispute while holding drawn credit.`,
      });
    }
  }

  alerts.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  const counts: Record<AlertSeverity, number> = { critical: 0, warning: 0, info: 0 };
  for (const a of alerts) counts[a.severity]++;

  return { generated_at: now, counts, alerts };
}
