import type { Ledger } from "../ledger/ledger.js";
import type { ChainEvent } from "../core/types.js";

/**
 * Notification feed — protocol events translated into human alerts.
 *
 * Folds the raw event stream into the actionable notifications an operator/agent
 * cares about (credit approved, funds drawn, dispute opened, agent slashed,
 * protocol paused, fiat receipt recorded), with a severity for UI styling. This
 * is the data behind the console's notification bell.
 */

export type Severity = "info" | "success" | "warning" | "critical";

export interface Notification {
  id: string;
  seq: number;
  severity: Severity;
  title: string;
  detail: string;
  agent_id?: string;
  timestamp: number;
}

interface Rule {
  severity: Severity;
  title: string;
  detail: (e: ChainEvent) => string;
}

const RULES: Record<string, Rule> = {
  AgentRegistered: { severity: "info", title: "Agent registered", detail: (e) => `${str(e, "agent_id")} (${str(e, "service_type")})` },
  CreditLineOpened: { severity: "success", title: "Credit line approved", detail: (e) => `${str(e, "agent_id")} · up to ${cspr(e, "max_credit")} CSPR` },
  CreditDrawn: { severity: "info", title: "Credit drawn", detail: (e) => `${str(e, "agent_id")} drew ${cspr(e, "amount")} CSPR` },
  CreditRepaid: { severity: "success", title: "Credit repaid", detail: (e) => `${str(e, "agent_id")} repaid ${cspr(e, "principal")} CSPR` },
  CreditFrozen: { severity: "warning", title: "Credit line frozen", detail: (e) => `${str(e, "agent_id")} · ${str(e, "reason")}` },
  CreditDefaulted: { severity: "critical", title: "Agent defaulted", detail: (e) => `${str(e, "agent_id")} defaulted` },
  DisputeOpened: { severity: "warning", title: "Dispute opened", detail: (e) => `${str(e, "dispute_type")} vs ${str(e, "respondent_agent")}` },
  DisputeVerdictIssued: { severity: "warning", title: "Dispute verdict", detail: (e) => `${str(e, "dispute_id")} → ${str(e, "verdict")}` },
  StakeSlashed: { severity: "critical", title: "Stake slashed", detail: (e) => `${str(e, "agent_id")} · ${cspr(e, "amount")} CSPR` },
  ProtocolPaused: { severity: "critical", title: "Protocol paused", detail: (e) => `${str(e, "area")}` },
  ProtocolUnpaused: { severity: "info", title: "Protocol resumed", detail: (e) => `${str(e, "area")}` },
  PolicyUpgraded: { severity: "info", title: "Risk policy upgraded", detail: (e) => `→ ${str(e, "current")}` },
  FiatReceiptRecorded: { severity: "info", title: "Fiat receipt", detail: (e) => `${str(e, "seller_agent")} · ${str(e, "currency")}` },
  OperatorVerified: { severity: "success", title: "Operator verified", detail: (e) => `${str(e, "operator_id")} (${str(e, "jurisdiction")})` },
  CreditOfferIssued: { severity: "info", title: "Pre-approval offer", detail: (e) => `${str(e, "agent_id")} · up to ${cspr(e, "max_credit")} CSPR` },
  CreditOfferAccepted: { severity: "success", title: "Offer accepted", detail: (e) => `${str(e, "agent_id")} · ${cspr(e, "max_credit")} CSPR line` },
};

export class NotificationService {
  constructor(private readonly ledger: Ledger) {}

  feed(limit = 30): Notification[] {
    const out: Notification[] = [];
    for (const e of this.ledger.bus.all()) {
      const rule = RULES[e.name];
      if (!rule) continue;
      out.push({
        id: `ntf-${e.seq}`,
        seq: e.seq,
        severity: rule.severity,
        title: rule.title,
        detail: rule.detail(e),
        agent_id: str(e, "agent_id") || undefined,
        timestamp: e.timestamp,
      });
    }
    return out.reverse().slice(0, limit);
  }
}

function str(e: ChainEvent, key: string): string {
  const v = (e.data as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}

function cspr(e: ChainEvent, key: string): string {
  const v = (e.data as Record<string, unknown>)[key];
  const motes = typeof v === "string" ? v : "0";
  return (Number(motes) / 1e9).toFixed(2);
}
