import { useState } from "react";
import { getCreditExplain, openCreditLine, drawCredit, repayCredit, fmtCspr, type CreditExplain, type UnderwriteResult } from "../api";

/**
 * LiveProof — the "90-second proof" from STRATEGY-2026-10-23.md §2 ("vs. Priors"),
 * as a product surface instead of a terminal-only `npm run demo`. Every step
 * below calls the REAL hosted API in sequence against the protocol's own
 * seeded demo agent (which has a real 30-day x402 revenue history from the
 * moment the API boots — see agents/economy.ts `bootstrap()`), and renders
 * each real response as it lands. No mocked steps, no canned JSON.
 */
const DEMO_AGENT = "EvidenceSellerAgent";

type StepStatus = "idle" | "running" | "done" | "error";
interface StepState {
  status: StepStatus;
  detail?: string;
}

const STEP_KEYS = ["score", "draw", "repay"] as const;
type StepKey = (typeof STEP_KEYS)[number];

const STEP_LABELS: Record<StepKey, string> = {
  score: "① Pull the real income-backed credit score",
  draw: "② Open + draw from the AgentCreditPool",
  repay: "③ Repay — close the loop on-chain",
};

export function LiveProof() {
  const [agentId, setAgentId] = useState(DEMO_AGENT);
  const [states, setStates] = useState<Record<StepKey, StepState>>({
    score: { status: "idle" },
    draw: { status: "idle" },
    repay: { status: "idle" },
  });
  const [explain, setExplain] = useState<CreditExplain | null>(null);
  const [underwrite, setUnderwrite] = useState<UnderwriteResult | null>(null);
  const [running, setRunning] = useState(false);

  const set = (key: StepKey, status: StepStatus, detail?: string) =>
    setStates((s) => ({ ...s, [key]: { status, detail } }));

  const run = async () => {
    setRunning(true);
    setExplain(null);
    setUnderwrite(null);
    let current: StepKey = "score";
    try {
      current = "score";
      set("score", "running");
      const ex = await getCreditExplain(agentId);
      if (ex.error || !ex.decision) throw new Error(ex.error ?? ex.ineligible_reason ?? "no decision");
      setExplain(ex);
      set("score", "done", `credit score ${ex.decision.credit_score}/100 · limit ${fmtCspr(ex.decision.credit_line)} CSPR`);

      current = "draw";
      set("draw", "running");
      const uw = await openCreditLine(agentId);
      setUnderwrite(uw);
      const drawAmount = Math.max(1, Math.min(5, Number(fmtCspr(uw.line.max_credit, 0)) || 1));
      await drawCredit(agentId, drawAmount);
      set("draw", "done", `drew ${drawAmount} CSPR against a ${fmtCspr(uw.line.max_credit)} CSPR line`);

      current = "repay";
      set("repay", "running");
      await repayCredit(agentId, drawAmount);
      set("repay", "done", `repaid ${drawAmount} CSPR — line closed clean`);
    } catch (err) {
      set(current, "error", (err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="card wide">
      <h3>The 90-second proof</h3>
      <p className="muted" style={{ marginTop: -8, marginBottom: 14 }}>
        Click once. Every step below is a real call to this API, not a recording — watch an
        agent's real x402 revenue history turn into a real credit score, a real drawn credit
        line, and a real repayment, live in your browser.
      </p>
      <div className="controls" style={{ marginBottom: 14 }}>
        <input className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} style={{ width: 220 }} placeholder="agent id" />
        <button className="btn primary" disabled={running} onClick={run}>
          {running ? "Running…" : "▶ Run the live proof"}
        </button>
      </div>

      {STEP_KEYS.map((key) => {
        const st = states[key];
        const icon = st.status === "done" ? "✓" : st.status === "error" ? "✗" : st.status === "running" ? "…" : "○";
        const cls = st.status === "done" ? "ok" : st.status === "error" ? "bad" : st.status === "running" ? "warn" : "";
        return (
          <div key={key} className="rowline">
            <span className={`chip ${cls}`}>{icon}</span>
            <b>{STEP_LABELS[key]}</b>
            {st.detail && <span className="muted">{st.detail}</span>}
          </div>
        );
      })}

      {explain?.decision?.reason_codes && explain.decision.reason_codes.length > 0 && (
        <div className="caps" style={{ marginTop: 12 }}>
          {explain.decision.reason_codes.map((rc) => (
            <span key={rc.code} className={`chip ${rc.polarity === "positive" ? "ok" : "warn"}`} title={rc.detail}>
              {rc.code}
            </span>
          ))}
        </div>
      )}

      {underwrite && (
        <p className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          Underwriting rationale: {underwrite.decision.rationale.join(" · ")}
        </p>
      )}
    </div>
  );
}
