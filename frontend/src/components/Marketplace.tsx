import { useEffect, useState } from "react";
import { getMarketplace, purchaseListing, createListing, getMarketplaceStats, fmtCspr, type MarketListing, type MarketplaceStats } from "../api";

const CATEGORIES = ["rwa.energy_output", "rwa.weather_risk", "rwa.invoice_validity", "rwa.shipping_status", "defi.yield_routing", "compliance.kyb_check"];
const STRATEGIES = ["fixed", "dynamic", "auction", "subscription", "reputation_tiered", "urgency", "data_cost_plus"];

/**
 * Marketplace tab (p4 §18) — the agent-services distribution surface. Listings are
 * ranked by on-chain trust (reputation, then receipt count). Any agent can buy a
 * listed service: a real x402 receipt is recorded, building the seller's revenue
 * and reputation — the flywheel, live.
 */
export function Marketplace() {
  const [listings, setListings] = useState<MarketListing[]>([]);
  const [stats, setStats] = useState<MarketplaceStats | null>(null);
  const [buyer, setBuyer] = useState("WeatherRiskAgent");
  const [msg, setMsg] = useState<string | null>(null);
  const [nl, setNl] = useState({ agent_id: "EvidenceSellerAgent", category: CATEGORIES[1]!, strategy: "fixed", base_price_cspr: 0.002 });

  const load = () => {
    getMarketplace().then(setListings).catch(() => setListings([]));
    getMarketplaceStats().then(setStats).catch(() => setStats(null));
  };
  useEffect(() => { load(); }, []);

  const list = async () => {
    const r = await createListing(nl);
    setMsg(r.data?.error ? `✗ ${r.data.error}` : `✓ listed ${nl.category} as ${r.data?.listing_id}`);
    load();
  };

  const buy = async (l: MarketListing) => {
    const r = await purchaseListing(l.listing_id, buyer);
    setMsg(r.error ? `✗ ${r.error}` : `✓ ${buyer} paid ${fmtCspr(r.receipt!.amount, 4)} CSPR to ${l.agent_id} — ${r.receipt!.receipt_id}`);
    load();
  };

  return (
    <div className="pool">
      {stats && stats.total_listings > 0 && (
        <div className="card wide">
          <h3>Marketplace stats</h3>
          <div className="stat-row">
            <Stat label="Listings" value={`${stats.total_listings}`} accent />
            <Stat label="Sellers" value={`${stats.sellers}`} />
            <Stat label="Avg seller rep" value={`${stats.avg_seller_reputation}/100`} />
            <Stat label="Avg price" value={`${fmtCspr(stats.price_motes.avg, 4)} CSPR`} />
          </div>
          <div className="caps">
            {Object.entries(stats.by_category).map(([c, n]) => (
              <span key={c} className="chip">{c}: {n}</span>
            ))}
            {Object.entries(stats.by_strategy).map(([s, n]) => (
              <span key={s} className="chip ok">{s}: {n}</span>
            ))}
          </div>
        </div>
      )}

      <div className="card wide">
        <h3>Agent service marketplace ({listings.length})</h3>
        <div className="controls">
          <span className="muted" style={{ alignSelf: "center" }}>Buyer agent:</span>
          <input className="input" value={buyer} onChange={(e) => setBuyer(e.target.value)} style={{ width: 220 }} />
        </div>
        {msg && <p className="muted">{msg}</p>}
        <table className="table">
          <thead>
            <tr>
              <th>Category</th><th>Agent</th><th>Pricing</th><th>Base price</th>
              <th>Reputation</th><th>Receipts</th><th>Chains</th><th></th>
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
                <td>{l.receipt_count}</td>
                <td>{l.supported_chains.map((c) => <span key={c} className="chip" style={{ marginRight: 4 }}>{c}</span>)}</td>
                <td><button className="btn" disabled={!buyer || buyer === l.agent_id} onClick={() => buy(l)}>Buy</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">7 pricing strategies: fixed, dynamic, auction, subscription, reputation-tiered, urgency, data-cost-plus.</p>
      </div>

      <div className="card wide">
        <h3>List a service</h3>
        <div className="controls">
          <input className="input" value={nl.agent_id} onChange={(e) => setNl({ ...nl, agent_id: e.target.value })} style={{ width: 180 }} placeholder="agent" />
          <select className="input" value={nl.category} onChange={(e) => setNl({ ...nl, category: e.target.value })}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select className="input" value={nl.strategy} onChange={(e) => setNl({ ...nl, strategy: e.target.value })}>
            {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input className="input" type="number" step="0.001" value={nl.base_price_cspr} onChange={(e) => setNl({ ...nl, base_price_cspr: Number(e.target.value) })} style={{ width: 110 }} />
          <button className="btn primary" onClick={list}>List</button>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}
