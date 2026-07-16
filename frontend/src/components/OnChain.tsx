import { useMemo, useState } from "react";
import type { ChainEvent } from "../types";
import type { ChainManifest } from "../api";
import { shortHash } from "../api";
import { indexContracts } from "../lib/explorer";
import { EventFeed } from "./EventFeed";

interface OnChainProps {
  manifest: ChainManifest | null;
  events: ChainEvent[];
  connected: boolean;
}

/**
 * On-Chain page — the single place to observe and verify protocol activity on
 * Casper. Shows the real deployed-contract registry (with one-click cspr.live
 * links), the deployer account, the node it lives on, a live per-contract event
 * count for this session, and the full streaming event log side-by-side.
 */
export function OnChain({ manifest, events, connected }: OnChainProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const contractIndex = useMemo(() => indexContracts(manifest), [manifest]);

  // Live count of events emitted per contract this session (observability signal).
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of events) m.set(e.contract, (m.get(e.contract) ?? 0) + 1);
    return m;
  }, [events]);

  const copy = async (text: string, key: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (!manifest) return <div className="empty">Loading on-chain deployment…</div>;

  return (
    <div className="layout-onchain">
      <section className="onchain-main">
        <div className="stat-row">
          <Stat label="Network" value={manifest.chain} accent />
          <Stat label="Contracts live" value={`${manifest.contract_count}`} />
          <Stat label="Mode" value={manifest.mode} />
          <Stat label="Events this session" value={`${events.length}`} />
        </div>

        <div className="card wide">
          <div className="onchain-head">
            <h3>Deployment</h3>
            <a className="csv-link" href={manifest.explorer} target="_blank" rel="noreferrer">open cspr.live ↗</a>
          </div>
          <div className="kv"><span className="muted">Deployer account</span>
            <span>
              <a href={manifest.deployer_url} target="_blank" rel="noreferrer" className="mono-link">{shortHash(manifest.deployer_public_key, 12)} ↗</a>
              <button className="link-btn" onClick={() => copy(manifest.deployer_public_key, "deployer")}>{copied === "deployer" ? "copied" : "copy"}</button>
            </span>
          </div>
          <div className="kv"><span className="muted">RPC node</span><code>{manifest.node}</code></div>
          <div className="kv"><span className="muted">Deployed at</span><span>{new Date(manifest.deployed_at).toLocaleString()}</span></div>
        </div>

        <div className="card wide">
          <div className="onchain-head">
            <h3>Contract registry — live on {manifest.chain}</h3>
            <a className="csv-link" href="/api/export/events.csv" title="Download the full on-chain event log">export events CSV ↗</a>
          </div>
          <p className="muted mono-sm" style={{ margin: "0 0 8px" }}>Click a contract to isolate its activity in the live feed →</p>
          <table className="table">
            <thead><tr><th>Contract</th><th>Hash</th><th>Events</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {manifest.contracts.map((c) => {
                const n = counts.get(c.name) ?? 0;
                const isFocus = focus === c.name;
                return (
                  <tr key={c.contract_hash} className={`clickable ${isFocus ? "row-focus" : ""}`} onClick={() => setFocus(isFocus ? null : c.name)}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted mono-sm">{c.crate}</div>
                    </td>
                    <td>
                      <code>{shortHash(c.contract_hash, 10)}</code>
                      <button className="link-btn" onClick={(e) => { e.stopPropagation(); copy(c.contract_hash, c.name); }}>{copied === c.name ? "copied" : "copy"}</button>
                    </td>
                    <td>{n > 0 ? <span className="chip ok">{n}</span> : <span className="muted">—</span>}</td>
                    <td><span className={`chip ${c.status === "installed" ? "ok" : "warn"}`}>{c.status}</span></td>
                    <td><a className="csv-link" href={c.explorer_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>cspr.live ↗</a></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="muted mono-sm" style={{ marginTop: 10 }}>
            Contract hashes are the real Odra (Rust→Wasm) contracts installed on {manifest.chain}. The event stream is the protocol's live event log for this session.
          </p>
        </div>
      </section>

      <aside className="onchain-feed">
        <EventFeed events={events} connected={connected} contractIndex={contractIndex} variant="page" focusContract={focus} onClearFocus={() => setFocus(null)} />
      </aside>
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
