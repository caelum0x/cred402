import { useMemo, useState } from "react";
import type { ChainEvent } from "../types";
import type { DeployedContract } from "../api";
import { fmtTime } from "../api";

const CRITICAL = new Set(["ReceiptDisputed", "StakeSlashed", "StakeSlashedToVault", "CreditFrozen", "CreditDefaulted", "DisputeOpened", "ExposureFrozen"]);
const POSITIVE = new Set([
  "ReceiptFinalized",
  "EvidenceVerified",
  "CreditLineOpened",
  "CreditRepaid",
  "ReputationUpdated",
  "PolicyUpgraded",
  "LiquidityDeposited",
  "OperatorVerified",
]);

type Level = "all" | "positive" | "critical";

interface EventFeedProps {
  events: ChainEvent[];
  /** Live vs. reconnecting, so the header can show the true stream state. */
  connected?: boolean;
  /** Name → deployed-contract lookup, for linking a row to cspr.live. */
  contractIndex?: Map<string, DeployedContract>;
  /** Compact sidebar mode (default) vs. roomier full-page mode. */
  variant?: "sidebar" | "page";
  /** Restrict the feed to a single contract's events (set from the registry). */
  focusContract?: string | null;
  /** Clear the contract focus. */
  onClearFocus?: () => void;
}

/**
 * EventFeed — the live on-chain activity stream. Every protocol contract call
 * emits a Casper-style event; this panel makes them observable: filter by text or
 * severity, pause the stream to inspect, expand any event to read its full data,
 * and jump to the emitting contract on the cspr.live block explorer.
 */
export function EventFeed({ events, connected, contractIndex, variant = "sidebar", focusContract, onClearFocus }: EventFeedProps) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<Level>("all");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<ChainEvent[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);

  // When paused, freeze the current list so the operator can inspect it while new
  // events keep streaming into `events` in the background.
  const source = paused ? frozen : events;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return source.filter((e) => {
      if (focusContract && e.contract !== focusContract) return false;
      if (level === "positive" && !POSITIVE.has(e.name)) return false;
      if (level === "critical" && !CRITICAL.has(e.name)) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.contract.toLowerCase().includes(q) ||
        JSON.stringify(e.data).toLowerCase().includes(q)
      );
    });
  }, [source, query, level, focusContract]);

  const togglePause = () => {
    if (!paused) setFrozen(events);
    setPaused((p) => !p);
  };

  return (
    <div className={`feed ${variant === "page" ? "feed-page" : ""}`}>
      <div className="feed-top">
        <h3>⟲ Casper on-chain events</h3>
        <span className={`feed-live ${connected ? "on" : "off"}`}>
          <span className="dot" /> {paused ? "paused" : connected ? "live" : "reconnecting"}
        </span>
      </div>

      <div className="feed-controls">
        {focusContract && (
          <button className="chip feed-chip warn sel focus-chip" onClick={onClearFocus} title="Clear contract focus">
            contract: {focusContract} ✕
          </button>
        )}
        <input
          className="input feed-search"
          placeholder="Filter events, contracts, data…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="feed-filters">
          {(["all", "positive", "critical"] as const).map((l) => (
            <button key={l} className={`chip feed-chip ${level === l ? "sel" : ""} ${l === "critical" ? "bad" : l === "positive" ? "ok" : ""}`} onClick={() => setLevel(l)}>
              {l}
            </button>
          ))}
          <button className={`chip feed-chip ${paused ? "warn sel" : ""}`} onClick={togglePause} title={paused ? "Resume live stream" : "Pause to inspect"}>
            {paused ? "▶ resume" : "⏸ pause"}
          </button>
        </div>
        <span className="feed-count">{filtered.length} event{filtered.length === 1 ? "" : "s"}{paused && frozen.length !== events.length ? ` · ${events.length - frozen.length} buffered` : ""}</span>
      </div>

      <div className="feed-list">
        {filtered.length === 0 && <p className="muted">{source.length === 0 ? "Waiting for on-chain activity…" : "No events match this filter."}</p>}
        {filtered.map((e) => {
          const contract = contractIndex?.get(e.contract);
          const isOpen = expanded === e.seq;
          return (
            <div key={e.seq} className={`feed-item ${cls(e.name)} ${isOpen ? "open" : ""}`}>
              <div className="feed-head clickable" onClick={() => setExpanded(isOpen ? null : e.seq)}>
                <span className="ev-name">{e.name}</span>
                <span className="ev-time">#{e.seq} · {fmtTime(e.timestamp)}</span>
              </div>
              <div className="feed-meta">
                {contract ? (
                  <a className="ev-contract-link" href={contract.explorer_url} target="_blank" rel="noreferrer" title={`View ${e.contract} on cspr.live`} onClick={(ev) => ev.stopPropagation()}>
                    {e.contract} ↗
                  </a>
                ) : (
                  <span className="ev-contract">{e.contract}</span>
                )}
                <code className="ev-deploy">{e.deploy_hash.slice(0, 12)}…</code>
              </div>
              {isOpen ? (
                <pre className="feed-json">{JSON.stringify(e.data, null, 2)}</pre>
              ) : (
                <div className="feed-data">{summarize(e)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function cls(name: string): string {
  if (CRITICAL.has(name)) return "critical";
  if (POSITIVE.has(name)) return "positive";
  return "";
}

function summarize(e: ChainEvent): string {
  const d = e.data;
  if (d.agent_id && d.amount) return `${d.agent_id} · ${d.amount} motes`;
  if (d.agent_id) return String(d.agent_id);
  if (d.receipt_id) return `receipt ${d.receipt_id}`;
  if (d.rwa_id) return `rwa ${d.rwa_id}`;
  if (d.current && d.previous) return `${d.previous} → ${d.current}`;
  return Object.keys(d).slice(0, 2).map((k) => `${k}=${String(d[k]).slice(0, 16)}`).join("  ");
}
