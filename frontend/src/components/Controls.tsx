import { useState } from "react";
import type { Snapshot } from "../types";
import { runDemo, resetDemo, upgradePolicy } from "../api";

export function Controls({ snapshot, onAction }: { snapshot: Snapshot | null; onAction: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function act(label: string, fn: () => Promise<void>) {
    setBusy(label);
    try {
      await fn();
      await onAction();
    } finally {
      setBusy(null);
    }
  }

  const nextPolicy = snapshot?.policyVersion === "v1" ? "v2" : "v1";

  return (
    <div className="controls">
      <button className="btn primary" disabled={!!busy} onClick={() => act("run", () => runDemo(false))}>
        {busy === "run" ? "Running…" : "▶ Run full loop"}
      </button>
      <button className="btn danger" disabled={!!busy} onClick={() => act("dispute", () => runDemo(true))}>
        {busy === "dispute" ? "Running…" : "⚠ Dispute & slash"}
      </button>
      <button className="btn" disabled={!!busy} onClick={() => act("policy", () => upgradePolicy(nextPolicy))}>
        ⬆ Upgrade policy → {nextPolicy}
      </button>
      <button className="btn ghost" disabled={!!busy} onClick={() => act("reset", () => resetDemo())}>
        ↺ Reset
      </button>
    </div>
  );
}
