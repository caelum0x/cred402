import type { Snapshot } from "../types";
import { fmtCspr, shortHash, fmtTime } from "../api";

export function Receipts({ snapshot }: { snapshot: Snapshot }) {
  const receipts = [...snapshot.receipts].sort((a, b) => b.timestamp - a.timestamp);
  return (
    <div className="card wide">
      <h3>x402 machine-to-machine receipts</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Payer</th>
            <th>Seller</th>
            <th>Service</th>
            <th>Amount</th>
            <th>Result hash</th>
            <th>Proof hash</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {receipts.length === 0 && (
            <tr>
              <td colSpan={8} className="muted">No receipts yet — run the loop or pay a /verify endpoint.</td>
            </tr>
          )}
          {receipts.map((r) => (
            <tr key={r.receipt_id}>
              <td>{fmtTime(r.timestamp)}</td>
              <td>{r.payer_agent}</td>
              <td>{r.seller_agent}</td>
              <td className="muted">{r.service_type}</td>
              <td>{fmtCspr(r.amount)} CSPR</td>
              <td><code>{shortHash(r.result_hash)}</code></td>
              <td><code>{shortHash(r.payment_proof_hash)}</code></td>
              <td><span className={`chip ${statusClass(r.status)}`}>{r.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statusClass(s: string): string {
  if (s === "finalized") return "ok";
  if (s === "disputed") return "bad";
  if (s === "settled") return "warn";
  return "";
}
