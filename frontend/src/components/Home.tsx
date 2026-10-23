import { useEffect, useState } from "react";
import { getAnalytics, fmtCspr, type AnalyticsView } from "../api";
import { CompetitorComparison } from "./CompetitorComparison";
import { LiveProof } from "./LiveProof";

/**
 * Home — the public marketing surface STRATEGY-2026-10-23.md flags as missing:
 * the console used to boot straight into the technical dashboard with no hero,
 * value prop, or CTA. This is the top of the discovery → evaluation funnel:
 * a hero with LIVE numbers (no fakes — pulled from GET /v1/analytics), a
 * 3-step "how it works", pricing, the competitor comparison, the 90-second
 * live proof, and a CTA into the console/docs.
 */
export function Home({ onEnterConsole }: { onEnterConsole: () => void }) {
  const [a, setA] = useState<AnalyticsView | null>(null);

  useEffect(() => {
    getAnalytics().then(setA).catch(() => setA(null));
  }, []);

  return (
    <div className="pool">
      <div className="card wide hero">
        <div className="hero-copy">
          <span className="chip accent">Apache-2.0 · Casper + x402</span>
          <h2 className="hero-title">Credit scores for autonomous agents, built from what they actually earn.</h2>
          <p className="hero-sub">
            Every agent that gets paid over x402 leaves a receipt trail. Cred402 turns that trail
            into an auditable credit score and a real, drawable credit line — no human
            underwriter, no closed formula, no KYC gate before the first dollar of credit.
          </p>
          <div className="controls">
            <button className="btn primary" onClick={onEnterConsole}>▶ Open the live console</button>
            <a className="btn" href="/pricing.html">Pricing — $0.01/lookup, no minimum</a>
            <a className="btn ghost" href="https://github.com/caelum0x/cred402" target="_blank" rel="noreferrer">↗ Read the source</a>
          </div>
        </div>
        <div className="stat-row hero-stats">
          <HeroStat label="Agents scored" value={a ? String(a.totals.agents) : "—"} />
          <HeroStat label="x402 volume" value={a ? `${fmtCspr(a.x402.total_volume_motes, 2)} CSPR` : "—"} />
          <HeroStat label="Credit issued" value={a ? `${fmtCspr(a.pool.outstanding_motes, 1)} CSPR` : "—"} />
          <HeroStat label="Receipts settled" value={a ? String(a.totals.finalized_receipts) : "—"} />
        </div>
      </div>

      <div className="card wide">
        <h3>How it works</h3>
        <div className="how-steps">
          <HowStep n={1} title="Agents earn over x402" body="Every paid call an agent settles — evidence, data, a service — mints a signed x402 receipt. No new integration: it's the payment protocol agents already use." />
          <HowStep n={2} title="Revenue becomes a score" body="RiskPolicyManager reads 30-day x402 revenue, stake, dispute rate and evidence accuracy into one auditable credit score with reason codes — Apache-2.0, no black box." />
          <HowStep n={3} title="The score becomes a credit line" body="AgentCreditPool opens a real revolving line against that score: draw, repay, get reviewed and re-priced as the agent's track record grows." />
        </div>
      </div>

      <LiveProof />
      <CompetitorComparison />

      <div className="card wide">
        <h3>Built for integrators, not just a demo</h3>
        <p className="muted">
          Score any x402-paid agent for 0.01 USDC per lookup, no monthly minimum — cheaper and
          more transparent than closed, enterprise-only competitors. One documented call
          underwrites credit on top of whichever payment rail you already use.
        </p>
        <div className="controls">
          <button className="btn primary" onClick={onEnterConsole}>▶ Open the live console</button>
          <a className="btn" href="/pricing.html">View pricing</a>
          <a className="btn ghost" href="https://github.com/caelum0x/cred402#readme" target="_blank" rel="noreferrer">↗ Read the docs</a>
        </div>
      </div>
    </div>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat accent">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function HowStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="how-step">
      <span className="how-step-n">{n}</span>
      <div>
        <b>{title}</b>
        <p className="muted">{body}</p>
      </div>
    </div>
  );
}
