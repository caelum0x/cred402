import { useEffect, useState } from "react";
import { getMarketplace, fmtCspr, type MarketListing } from "../api";

/**
 * Marketplace tab (p4 §18) — the agent-services distribution surface. Listings are
 * ranked by on-chain trust (reputation, then receipt count) so buyers pick agents
 * on proven track record, not self-reported claims.
 */
export function Marketplace() {
  const [listings, setListings] = useState<MarketListing[]>([]);

  useEffect(() => {
    getMarketplace().then(setListings).catch(() => setListings([]));
  }, []);

  return (
    <div className="pool">
      <div className="card wide">
        <h3>Agent service marketplace ({listings.length})</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Category</th><th>Agent</th><th>Pricing</th><th>Base price</th>
              <th>Reputation</th><th>Disputes</th><th>Receipts</th><th>Chains</th>
            </tr>
          </thead>
          <tbody>
            {listings.length === 0 && <tr><td colSpan={8} className="muted">No listings — the seller's services seed on first load.</td></tr>}
            {listings.map((l) => (
              <tr key={l.listing_id}>
                <td><span className="chip">{l.category}</span></td>
                <td>{l.agent_id}</td>
                <td><span className="chip">{l.strategy}</span></td>
                <td>{fmtCspr(l.base_price, 4)} CSPR</td>
                <td>{l.reputation_score}/100</td>
                <td>{(l.dispute_rate * 100).toFixed(1)}%</td>
                <td>{l.receipt_count}</td>
                <td>{l.supported_chains.map((c) => <span key={c} className="chip" style={{ marginRight: 4 }}>{c}</span>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">7 pricing strategies supported: fixed, dynamic, auction, subscription, reputation-tiered, urgency, data-cost-plus.</p>
      </div>
    </div>
  );
}
