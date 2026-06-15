import type { ChainEvent } from "../types";
import { fmtTime } from "../api";

const CRITICAL = new Set(["ReceiptDisputed", "StakeSlashed", "CreditFrozen"]);
const POSITIVE = new Set([
  "ReceiptFinalized",
  "EvidenceVerified",
  "CreditLineOpened",
  "CreditRepaid",
  "ReputationUpdated",
  "PolicyUpgraded",
]);

export function EventFeed({ events }: { events: ChainEvent[] }) {
  return (
    <div className="feed">
      <h3>⟲ Casper streaming events</h3>
      <div className="feed-list">
        {events.length === 0 && <p className="muted">Waiting for on-chain activity…</p>}
        {events.map((e) => (
          <div key={e.seq} className={`feed-item ${cls(e.name)}`}>
            <div className="feed-head">
              <span className="ev-name">{e.name}</span>
              <span className="ev-time">{fmtTime(e.timestamp)}</span>
            </div>
            <div className="feed-meta">
              <span className="ev-contract">{e.contract}</span>
              <code className="ev-deploy">{e.deploy_hash.slice(0, 12)}…</code>
            </div>
            <div className="feed-data">{summarize(e)}</div>
          </div>
        ))}
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
