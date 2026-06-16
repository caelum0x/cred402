import type { Ledger } from "../ledger/ledger.js";
import { SanctionsScreener } from "../compliance/sanctions.js";

/**
 * Per-jurisdiction compliance report — the view a compliance officer needs:
 * operators grouped by jurisdiction, KYB coverage, and sanctions exposure. Built
 * from the on-chain OperatorVerificationRegistry + sanctions lists.
 */

export interface JurisdictionRow {
  jurisdiction: string;
  operators: number;
  verified: number;
  sanctioned: boolean;
  agents: string[];
}

export interface ComplianceReport {
  generated_at: number;
  total_operators: number;
  verified_operators: number;
  kyb_coverage: number; // 0..1
  sanctioned_exposure: number; // operators in sanctioned jurisdictions
  by_jurisdiction: JurisdictionRow[];
}

export function buildComplianceReport(ledger: Ledger): ComplianceReport {
  const screener = new SanctionsScreener();
  const operators = ledger.operators.list();
  // Map operator_id -> agents that declare it (from passports).
  const operatorAgents = new Map<string, string[]>();
  for (const a of ledger.agents.list()) {
    const op = ledger.buildPassport(a.agent_id)?.operator;
    if (op) operatorAgents.set(op, [...(operatorAgents.get(op) ?? []), a.agent_id]);
  }

  const byJur = new Map<string, JurisdictionRow>();
  let verified = 0;
  let sanctionedExposure = 0;
  for (const o of operators) {
    const jur = (o.jurisdiction || "??").toUpperCase();
    const row = byJur.get(jur) ?? { jurisdiction: jur, operators: 0, verified: 0, sanctioned: screener.screenJurisdiction(jur).matched, agents: [] };
    row.operators++;
    const isVerified = ledger.operators.is_verified(o.operator_id);
    if (isVerified) {
      row.verified++;
      verified++;
    }
    if (row.sanctioned) sanctionedExposure++;
    row.agents.push(...(operatorAgents.get(o.operator_id) ?? []));
    byJur.set(jur, row);
  }

  return {
    generated_at: ledger.clock.now(),
    total_operators: operators.length,
    verified_operators: verified,
    kyb_coverage: operators.length ? Math.round((verified / operators.length) * 1000) / 1000 : 0,
    sanctioned_exposure: sanctionedExposure,
    by_jurisdiction: [...byJur.values()].sort((a, b) => b.operators - a.operators),
  };
}
