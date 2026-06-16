import type { Ledger } from "../ledger/ledger.js";
import { FraudService } from "./fraud_service.js";
import { ComplianceService } from "../compliance/service.js";

/**
 * Onboarding readiness scorecard — the funnel view an agent (or its operator) needs:
 * "what do I still have to do to qualify for credit?". It evaluates each gate the
 * underwriter enforces and returns a pass/fail checklist with concrete guidance,
 * plus an overall readiness percentage. Read-only; mirrors the live policy gates so
 * a fully-ready agent is one underwriting will actually approve.
 */

export interface ReadinessItem {
  requirement: string;
  met: boolean;
  detail: string;
  guidance: string; // what to do if unmet
  blocking: boolean; // does this gate hard-block credit?
}

export interface OnboardingScorecard {
  agent_id: string;
  ready: boolean; // all blocking gates satisfied
  readiness_pct: number; // share of all items met, 0..100
  items: ReadinessItem[];
}

export function buildOnboardingScorecard(ledger: Ledger, agentId: string): OnboardingScorecard | { error: string } {
  const agent = ledger.agents.get(agentId);
  if (!agent) return { error: `unknown agent: ${agentId}` };

  const gov = ledger.governance.get();
  const fraud = new FraudService(ledger).analyze(agentId);
  const compliance = new ComplianceService(ledger).screenAgent(agentId);
  const finalizedReceipts = ledger.receipts.forSeller(agentId).filter((r) => r.status === "finalized").length;
  const operatorId = ledger.buildPassport(agentId)?.operator;
  const operatorVerified = operatorId ? ledger.operators.is_verified(operatorId) : false;
  const openDisputes = ledger.disputes.openCount(agentId);

  const items: ReadinessItem[] = [
    {
      requirement: "Registered agent",
      met: true,
      detail: `registered as ${agent.service_type}`,
      guidance: "—",
      blocking: true,
    },
    {
      requirement: `Reputation ≥ ${gov.min_reputation_to_draw}`,
      met: agent.reputation_score >= gov.min_reputation_to_draw,
      detail: `reputation ${agent.reputation_score}/${gov.min_reputation_to_draw}`,
      guidance: "Complete more verified jobs and earn x402 receipts to raise reputation.",
      blocking: true,
    },
    {
      requirement: "No open disputes",
      met: openDisputes === 0,
      detail: openDisputes === 0 ? "no open disputes" : `${openDisputes} open dispute(s)`,
      guidance: "Resolve outstanding disputes before drawing credit.",
      blocking: true,
    },
    {
      requirement: "Fraud risk below threshold",
      met: fraud.score < 70,
      detail: `fraud score ${fraud.score}/70${fraud.flags.length ? ` (${fraud.flags.map((f) => f.code).join(", ")})` : ""}`,
      guidance: "Diversify counterparties and avoid wash-trading patterns flagged by the fraud graph.",
      blocking: true,
    },
    {
      requirement: "Compliance cleared",
      met: compliance.cleared,
      detail: compliance.cleared ? "cleared" : compliance.blocking_reason ?? "blocked",
      guidance: "Clear sanctions/jurisdiction checks; complete operator KYB if required.",
      blocking: true,
    },
    {
      requirement: "Revenue history (≥ 1 finalized receipt)",
      met: finalizedReceipts >= 1,
      detail: `${finalizedReceipts} finalized receipt(s)`,
      guidance: "Earn and finalize at least one x402 receipt — revenue is the primary credit signal.",
      blocking: false,
    },
    {
      requirement: "Stake posted",
      met: agent.stake > 0n,
      detail: agent.stake > 0n ? `${Number(agent.stake) / 1e9} CSPR staked` : "no stake",
      guidance: "Post stake to boost your credit line via the stake multiplier (optional but recommended).",
      blocking: false,
    },
    {
      requirement: "Operator KYB verified",
      met: operatorVerified,
      detail: operatorVerified ? `operator ${operatorId} verified` : "operator unverified or anonymous",
      guidance: "Verify your operator (RealFi) to unlock the RealFi credit multiplier and higher limits.",
      blocking: false,
    },
  ];

  const met = items.filter((i) => i.met).length;
  const ready = items.filter((i) => i.blocking).every((i) => i.met);
  return {
    agent_id: agentId,
    ready,
    readiness_pct: Math.round((met / items.length) * 100),
    items,
  };
}
