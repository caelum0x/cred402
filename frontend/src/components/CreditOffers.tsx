import { useEffect, useState } from "react";
import { listCreditOffers, issueCreditOffer, decideCreditOffer, fmtCspr, type CreditOffer } from "../api";
import type { Snapshot } from "../types";

/**
 * Credit pre-approval offers — an underwriter issues a time-bounded offer (terms
 * from the live risk policy); an agent accepts to open a line at the locked terms,
 * or it expires. Reads /v1/credit/offers, writes the issue/accept/decline actions.
 */
export function CreditOffers({ snapshot }: { snapshot: Snapshot }) {
  const [offers, setOffers] = useState<CreditOffer[]>([]);
  const [agent, setAgent] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => listCreditOffers().then(setOffers).catch(() => setOffers([]));
  useEffect(() => {
    load();
  }, []);

  const issue = async () => {
    setMsg(null);
    const r = await issueCreditOffer(agent.trim());
    if ("error" in r && r.error) setMsg(`✗ ${r.error}`);
    else {
      setMsg(`✓ offer issued for ${agent}`);
      setAgent("");
      await load();
    }
  };

  const decide = async (id: string, action: "accept" | "decline") => {
    const r = await decideCreditOffer(id, action);
    setMsg(r.error ? `✗ ${r.error}` : `✓ offer ${action}ed`);
    await load();
  };

  const agentIds = snapshot.agents.map((a) => a.agent_id);

  return (
    <div className="card wide">
      <h3>Credit pre-approval offers</h3>
      <div className="controls" style={{ flexWrap: "wrap", gap: 8 }}>
        <input
          className="input"
          placeholder="agent id"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          list="offer-agents"
        />
        <datalist id="offer-agents">
          {agentIds.map((id) => (
            <option key={id} value={id} />
          ))}
        </datalist>
        <button className="btn primary" disabled={!agent.trim()} onClick={issue}>Issue offer</button>
        {msg && <span className="muted" style={{ alignSelf: "center" }}>{msg}</span>}
      </div>

      {offers.length === 0 ? (
        <p className="muted" style={{ marginTop: 8 }}>No offers yet. Issue a pre-approval above.</p>
      ) : (
        <table className="table" style={{ marginTop: 8 }}>
          <thead>
            <tr><th>Agent</th><th>Max line</th><th>APR</th><th>Score</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            {offers.map((o) => (
              <tr key={o.offer_id}>
                <td>{o.agent_id}</td>
                <td>{fmtCspr(o.max_credit_motes)} CSPR</td>
                <td>{(o.interest_rate_bps / 100).toFixed(1)}%</td>
                <td>{o.credit_score}/100</td>
                <td>
                  <span className={`chip ${o.status === "accepted" ? "ok" : o.status === "pending" ? "warn" : "bad"}`}>{o.status}</span>
                </td>
                <td>
                  {o.status === "pending" && (
                    <span className="controls" style={{ margin: 0, gap: 4 }}>
                      <button className="btn" onClick={() => decide(o.offer_id, "accept")}>Accept</button>
                      <button className="btn" onClick={() => decide(o.offer_id, "decline")}>Decline</button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
