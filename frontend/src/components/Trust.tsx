import { useEffect, useState } from "react";
import { getAttestationGraph, postAttestation, type AttestationGraphView, type TrustNode } from "../api";

/**
 * Trust page — the agent web of trust. Established agents vouch for others; a vouch
 * from a high-reputation agent grants a small, capped reputation boost (anti-Sybil).
 * This renders the directed attestation graph as an SVG and lets an operator issue a
 * new vouch. Reads /v1/attestations/graph, writes /v1/attestations.
 */
export function Trust() {
  const [g, setG] = useState<AttestationGraphView | null>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => getAttestationGraph().then(setG).catch(() => setG(null));
  useEffect(() => {
    load();
  }, []);

  const submit = async () => {
    setMsg(null);
    const r = await postAttestation(from.trim(), to.trim(), note.trim());
    if (r.error) setMsg(`✗ ${r.error}`);
    else {
      setMsg(`✓ ${from} vouched for ${to}`);
      setFrom("");
      setTo("");
      setNote("");
      await load();
    }
  };

  if (!g) return <div className="empty">Loading trust graph…</div>;

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Attestations" value={`${g.total_attestations}`} accent />
        <Stat label="Vouched agents" value={`${g.nodes.length}`} />
        <Stat label="Top trust" value={g.nodes[0] ? `${g.nodes[0].agent_id} (${g.nodes[0].trust_score})` : "—"} />
      </div>

      <div className="card wide">
        <h3>
          Issue a vouch{" "}
          <button className="link-btn" onClick={load}>
            ↻ refresh
          </button>
        </h3>
        <div className="controls" style={{ flexWrap: "wrap", gap: 8 }}>
          <input className="input" placeholder="from agent (rep ≥ 60)" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input" placeholder="to agent" value={to} onChange={(e) => setTo(e.target.value)} />
          <input className="input" placeholder="note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn primary" disabled={!from.trim() || !to.trim()} onClick={submit}>
            ✋ Vouch
          </button>
          {msg && <span className="muted" style={{ alignSelf: "center" }}>{msg}</span>}
        </div>
      </div>

      <div className="card wide">
        <h3>Web of trust</h3>
        {g.edges.length === 0 ? (
          <p className="muted">No attestations yet — issue the first vouch above.</p>
        ) : (
          <TrustGraphSvg view={g} />
        )}
      </div>

      <div className="card wide">
        <h3>Trust ranking</h3>
        <table className="table">
          <thead>
            <tr><th>#</th><th>Agent</th><th>Trust score</th><th>Vouches received</th><th>Vouches given</th><th>Reputation</th></tr>
          </thead>
          <tbody>
            {g.nodes.map((n, i) => (
              <tr key={n.agent_id}>
                <td>{i + 1}</td>
                <td>{n.agent_id}</td>
                <td><span className={`chip ${n.trust_score > 0 ? "ok" : ""}`}>+{n.trust_score}</span></td>
                <td>{n.in_degree}</td>
                <td>{n.out_degree}</td>
                <td>{n.reputation}/100</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A circular-layout directed graph: nodes on a ring, vouches as arrowed chords. */
function TrustGraphSvg({ view }: { view: AttestationGraphView }) {
  const size = 460;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 70;
  const nodes = view.nodes;
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
    pos.set(n.agent_id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
  });
  const radius = (n: TrustNode) => 6 + Math.min(14, n.trust_score * 2 + n.in_degree * 1.5);

  return (
    <svg width="100%" viewBox={`0 0 ${size} ${size}`} style={{ maxWidth: size, display: "block", margin: "0 auto" }}>
      <defs>
        <marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L7,3 L0,6 Z" fill="#7c8aff" />
        </marker>
      </defs>
      {view.edges.map((e, i) => {
        const a = pos.get(e.from);
        const b = pos.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            stroke="#7c8aff"
            strokeOpacity={0.45}
            strokeWidth={1 + e.weight * 0.6}
            markerEnd="url(#arrow)"
          />
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.agent_id)!;
        return (
          <g key={n.agent_id}>
            <circle cx={p.x} cy={p.y} r={radius(n)} fill={n.in_degree > 0 ? "#3fd07a" : "#4a5170"} stroke="#0d1020" strokeWidth={1.5}>
              <title>{`${n.agent_id} · trust ${n.trust_score} · in ${n.in_degree} / out ${n.out_degree}`}</title>
            </circle>
            <text x={p.x} y={p.y - radius(n) - 5} textAnchor="middle" fontSize={10} fill="#aab" >
              {n.agent_id.length > 16 ? n.agent_id.slice(0, 15) + "…" : n.agent_id}
            </text>
          </g>
        );
      })}
    </svg>
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
