import type { Ledger } from "../ledger/ledger.js";
import { SanctionsScreener } from "./sanctions.js";
import { JurisdictionPolicy } from "./jurisdiction.js";
import { DataRetentionPolicy } from "./data_retention.js";

/**
 * ComplianceService (p2 §7.9) — the policy gate underwriting consults before any
 * credit decision. Composes KYB status (from the on-chain
 * OperatorVerificationRegistry), sanctions screening, and jurisdiction policy
 * into a single cleared/blocked verdict with an itemized check list. It is a
 * technical adapter — real operating rules are set by counsel (p6 §603) — but it
 * makes the protocol refuse credit to sanctioned/blocked operators by default.
 */

export interface ComplianceCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ComplianceResult {
  subject: string;
  cleared: boolean;
  checks: ComplianceCheck[];
  blocking_reason?: string;
}

export interface ComplianceOptions {
  sanctions?: SanctionsScreener;
  jurisdiction?: JurisdictionPolicy;
  retention?: DataRetentionPolicy;
  /** Minimum operator verification level required to borrow (default: business). */
  requireKyb?: boolean;
}

export class ComplianceService {
  readonly sanctions: SanctionsScreener;
  readonly jurisdiction: JurisdictionPolicy;
  readonly retention: DataRetentionPolicy;
  private readonly requireKyb: boolean;

  constructor(
    private readonly ledger: Ledger,
    opts: ComplianceOptions = {},
  ) {
    this.sanctions = opts.sanctions ?? new SanctionsScreener();
    this.jurisdiction = opts.jurisdiction ?? new JurisdictionPolicy();
    this.retention = opts.retention ?? new DataRetentionPolicy();
    this.requireKyb = opts.requireKyb ?? false; // off by default for testnet
  }

  /** Screen an operator: sanctions (subject + jurisdiction), KYB, lending policy. */
  screenOperator(operator_id: string): ComplianceResult {
    const checks: ComplianceCheck[] = [];
    const verification = this.ledger.operators.get_operator_verification(operator_id);
    const jurisdiction = verification?.jurisdiction;

    // 1. Subject sanctions.
    const subjHit = this.sanctions.screenSubject(operator_id);
    checks.push({ name: "sanctions:subject", passed: !subjHit.matched, detail: subjHit.reason ?? "not denylisted" });

    // 2. Jurisdiction sanctions + lending policy (only if jurisdiction is known).
    if (jurisdiction) {
      const jHit = this.sanctions.screenJurisdiction(jurisdiction);
      checks.push({ name: "sanctions:jurisdiction", passed: !jHit.matched, detail: jHit.reason ?? `${jurisdiction} clear` });
      const lend = this.jurisdiction.canLend(jurisdiction);
      checks.push({ name: "jurisdiction:lending", passed: lend.allowed, detail: lend.reason ?? `lending allowed in ${jurisdiction}` });
    } else {
      checks.push({ name: "jurisdiction:lending", passed: !this.requireKyb, detail: "operator jurisdiction unknown (no KYB)" });
    }

    // 3. KYB level (operator currently verified).
    const kyb = this.ledger.operators.is_verified(operator_id);
    checks.push({ name: "kyb:verified", passed: this.requireKyb ? kyb : true, detail: kyb ? "verified operator" : "no current KYB verification" });

    const failed = checks.find((c) => !c.passed);
    return {
      subject: operator_id,
      cleared: !failed,
      checks,
      blocking_reason: failed?.detail,
    };
  }

  /** Resolve an agent's operator and screen it; agents with no operator pass (testnet). */
  screenAgent(agent_id: string): ComplianceResult {
    const operator_id = this.ledger.buildPassport(agent_id)?.operator;
    if (!operator_id) {
      const subjHit = this.sanctions.screenSubject(agent_id);
      return {
        subject: agent_id,
        cleared: !subjHit.matched && !this.requireKyb,
        checks: [
          { name: "sanctions:subject", passed: !subjHit.matched, detail: subjHit.reason ?? "not denylisted" },
          { name: "kyb:operator", passed: !this.requireKyb, detail: "no operator linked" },
        ],
        blocking_reason: subjHit.matched ? subjHit.reason : this.requireKyb ? "operator KYB required" : undefined,
      };
    }
    return this.screenOperator(operator_id);
  }
}
