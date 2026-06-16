import { useState } from "react";
import { getReadiness, type OnboardingScorecard } from "../api";

/**
 * Agent onboarding wizard — walks a new agent through the full join flow against
 * the live protocol: register identity → stake collateral → verify operator
 * (RealFi KYB) → list a service. Each step is a real API call; the wizard shows
 * progress and the resulting on-chain state.
 */
type StepState = "idle" | "running" | "done" | "error";
interface Step {
  key: string;
  label: string;
  run: (ctx: Ctx) => Promise<string>;
}
interface Ctx {
  agentId: string;
  serviceType: string;
  operatorId: string;
}

async function post(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await res.json()) as { success?: boolean; data?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "request failed");
  return j.data ?? j;
}

const STEPS: Step[] = [
  {
    key: "register",
    label: "Register identity",
    run: async (c) => {
      await post("/v1/agents", { agent_id: c.agentId, service_type: c.serviceType });
      return `registered ${c.agentId}`;
    },
  },
  {
    key: "stake",
    label: "Stake collateral (10 CSPR)",
    run: async (c) => {
      await post(`/v1/agents/${encodeURIComponent(c.agentId)}/stake`, { amount_cspr: 10 });
      return "staked 10 CSPR";
    },
  },
  {
    key: "operator",
    label: "Verify operator (Stripe Identity)",
    run: async (c) => {
      await post("/v1/realfi/operators", { operator_id: c.operatorId, jurisdiction: "US", verification_level: "business_verified", verification_reference: `kyb-${c.agentId}` });
      return `operator ${c.operatorId} verified`;
    },
  },
  {
    key: "list",
    label: "List a service",
    run: async (c) => {
      const r = (await post("/v1/marketplace/listings", { agent_id: c.agentId, category: "rwa.weather_risk", strategy: "reputation_tiered", base_price_cspr: 0.003 })) as { listing_id?: string };
      return `listed as ${r.listing_id ?? "ok"}`;
    },
  },
];

export function Onboard() {
  const [agentId, setAgentId] = useState("NewAgent-" + Math.floor(Math.random() * 1000));
  const [serviceType, setServiceType] = useState("weather_risk");
  const [states, setStates] = useState<Record<string, { state: StepState; msg?: string }>>({});
  const [readiness, setReadiness] = useState<OnboardingScorecard | null>(null);

  const checkReadiness = async () => {
    const r = await getReadiness(agentId).catch(() => null);
    setReadiness(r && !("error" in r) ? r : null);
  };

  const run = async () => {
    const ctx: Ctx = { agentId, serviceType, operatorId: `operator:${agentId.toLowerCase()}` };
    for (const step of STEPS) {
      setStates((s) => ({ ...s, [step.key]: { state: "running" } }));
      try {
        const msg = await step.run(ctx);
        setStates((s) => ({ ...s, [step.key]: { state: "done", msg } }));
      } catch (e) {
        setStates((s) => ({ ...s, [step.key]: { state: "error", msg: (e as Error).message } }));
        break;
      }
    }
    await checkReadiness();
  };

  return (
    <div className="pool">
      <div className="card wide">
        <h3>Onboard a new agent</h3>
        <div className="controls">
          <input className="input" value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent id" style={{ width: 200 }} />
          <select className="input" value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
            {["weather_risk", "solar_output_verification", "receivable_quality", "risk_scoring", "treasury_routing", "monitoring"].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <button className="btn primary" onClick={run}>▶ Run onboarding</button>
          <button className="btn" onClick={checkReadiness}>Check credit readiness</button>
        </div>
      </div>

      {readiness && (
        <div className="card wide">
          <h3>
            Credit readiness{" "}
            <span className={`chip ${readiness.ready ? "ok" : "warn"}`}>
              {readiness.ready ? "READY" : "not ready"} · {readiness.readiness_pct}%
            </span>
          </h3>
          {readiness.items.map((i) => (
            <div key={i.requirement} className="rowline">
              <span className={`chip ${i.met ? "ok" : i.blocking ? "bad" : "warn"}`}>{i.met ? "✓" : "✗"}</span>
              <b>{i.requirement}</b> {i.blocking && !i.met && <span className="chip bad">blocking</span>}
              <span className="muted">{i.detail}</span>
              {!i.met && <span className="muted" style={{ fontStyle: "italic" }}>→ {i.guidance}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="card wide">
        <h3>Steps</h3>
        {STEPS.map((step) => {
          const st = states[step.key];
          const icon = st?.state === "done" ? "✓" : st?.state === "error" ? "✗" : st?.state === "running" ? "…" : "○";
          const cls = st?.state === "done" ? "ok" : st?.state === "error" ? "bad" : st?.state === "running" ? "warn" : "";
          return (
            <div key={step.key} className="rowline">
              <span className={`chip ${cls}`}>{icon}</span>
              <b>{step.label}</b>
              {st?.msg && <span className="muted">{st.msg}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
