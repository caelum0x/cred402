import { useEffect, useState } from "react";
import { search, type SearchResult } from "../api";

/**
 * Explorer page — one search box over the whole protocol. Paste any id or hash
 * (agent, receipt, evidence, RWA asset, credit line, dispute, or Casper deploy
 * hash) and resolve it. Reads /api/search.
 */
const KIND_COLOR: Record<string, string> = {
  agent: "ok",
  receipt: "",
  evidence: "",
  asset: "warn",
  credit_line: "ok",
  dispute: "bad",
  transaction: "",
};

export function Explorer() {
  const [q, setQ] = useState("SOLAR");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      return;
    }
    setLoading(true);
    const t = setTimeout(() => {
      search(q).then(setResults).catch(() => setResults([])).finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="pool">
      <div className="controls">
        <input
          className="input"
          style={{ flex: 1, minWidth: 280 }}
          placeholder="Search agents, receipts, evidence, assets, disputes, tx hashes…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>

      <div className="card wide">
        <h3>{loading ? "Searching…" : `${results.length} result${results.length === 1 ? "" : "s"}`}</h3>
        <table className="table">
          <thead><tr><th>Kind</th><th>Id</th><th>Detail</th></tr></thead>
          <tbody>
            {results.length === 0 && !loading && <tr><td colSpan={3} className="muted">No matches. Try an agent name, “SOLAR”, a receipt id, or a hash.</td></tr>}
            {results.map((r) => (
              <tr key={`${r.kind}:${r.id}`}>
                <td><span className={`chip ${KIND_COLOR[r.kind] ?? ""}`}>{r.kind}</span></td>
                <td><code>{r.label}</code></td>
                <td className="muted">{r.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
