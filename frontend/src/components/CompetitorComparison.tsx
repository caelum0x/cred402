/**
 * CompetitorComparison — a real, numbers-first comparison table, not prose.
 *
 * Every cell below is drawn directly from the axes drafted in
 * STRATEGY-2026-10-23.md §2 ("Exact differentiation plan — one concrete axis
 * per competitor"). No invented numbers: Clawloan's traction figures and the
 * Nevermined/Coinbase-x402 prices are the real, published ones as of 2026-10-23;
 * everything else is a structural (code-verifiable) claim about cred402 itself.
 */
interface Row {
  axis: string;
  competitor: string;
  competitorValue: string;
  cred402Value: string;
}

const ROWS: Row[] = [
  {
    axis: "Auditability",
    competitor: "Bank of Bots",
    competitorValue: "Closed, proprietary “BOB Score” — formula not published",
    cred402Value: "Apache-2.0 scoring code in this repo (lib/services, RiskPolicyManager) — every decision ships reason codes",
  },
  {
    axis: "Chain coverage",
    competitor: "Clawloan",
    competitorValue: "One rail — OpenClaw agents only",
    cred402Value: "5 rails feed one score: Algorand (live), QIE + NEAR (wiring in progress), Casper-anchored receipts, EVM satellite (Base Sepolia)",
  },
  {
    axis: "Score → loan",
    competitor: "Priors",
    competitorValue: "Income-backed score tier — no public lending product on top of it",
    cred402Value: "Working AgentCreditPool: deposit → underwrite → draw → repay → liquidate, live below on this page",
  },
  {
    axis: "Evidence & dispute",
    competitor: "Huma Finance / Centrifuge",
    competitorValue: "Trusts off-chain income oracles — no adversarial check on the data itself",
    cred402Value: "RWAEvidenceRegistry + DisputeCourt + SlashingVault — falsified evidence gets caught and slashed before credit is extended",
  },
  {
    axis: "Layer",
    competitor: "Skyfire / Nevermined / Coinbase x402",
    competitorValue: "Payment rails — agents can pay, but can’t borrow against history",
    cred402Value: "Sits on top of whichever rail you already picked: one documented call underwrites credit for payments made over any of them",
  },
  {
    axis: "Price",
    competitor: "Nevermined",
    competitorValue: "$250–500/mo + 1–2% take rate (Bank of Bots / Priors: undisclosed)",
    cred402Value: "0.01 USDC per credit-score lookup, no monthly minimum",
  },
];

export function CompetitorComparison() {
  return (
    <div className="card wide">
      <h3>How cred402 compares</h3>
      <p className="muted" style={{ marginTop: -8, marginBottom: 14 }}>
        One concrete, checkable axis per competitor — not a marketing claim. Source: STRATEGY-2026-10-23.md §2.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Axis</th>
            <th>Competitor</th>
            <th>Their position</th>
            <th>cred402</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.axis}>
              <td><b>{r.axis}</b></td>
              <td className="muted">{r.competitor}</td>
              <td className="muted">{r.competitorValue}</td>
              <td><span className="chip ok">{r.cred402Value}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
