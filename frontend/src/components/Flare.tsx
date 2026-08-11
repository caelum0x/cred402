import { useEffect, useState } from "react";

/**
 * Flare page — the interoperable-asset credit satellite and its KeeperHub execution
 * layer, made observable. Shows the Flare network + FXRP pool, the live FTSO XRP/USD
 * price, KeeperHub reliability (executions, private routing, gas backoff, settlement
 * protocol), and the full per-execution audit trail. Reads /api/flare; the button
 * runs one FXRP credit loop (draw → repay) through KeeperHub on the shared state.
 */

interface AuditRecord {
  audit_id: string;
  execution_id: string;
  agent_id?: string;
  chain_id: string;
  intent_kind: string;
  label: string;
  gas: { max_fee_per_gas: string; attempts: number; strategy: string };
  payment: { protocol: string; amount: string; asset: string; network: string };
  private_routed: boolean;
  sponsored: boolean;
  tx_hash: string;
  gas_used?: number;
  status: string;
}

interface Reliability {
  total: number;
  confirmed: number;
  failed: number;
  private_routed: number;
  sponsored: number;
  avg_backoff_attempts: number;
  total_gas_used: number;
  by_protocol: Record<string, number>;
}

interface FlareView {
  info: {
    network: string;
    chain: string;
    explorer: string;
    pool: string;
    asset: string;
    liquidity_fxrp: string;
    ftso_live: boolean;
    keeperhub_live: boolean;
    keeperhub_enabled: boolean;
  };
  price: { value: number; source: string };
  reliability: Reliability;
  audit: AuditRecord[];
  seller: string;
}

interface PositionHealth {
  agent_id: string;
  fxrp_debt_whole: number;
  xrp_usd: number;
  debt_usd: number;
  cap_usd: number;
  health_factor: number;
  status: string;
}
interface KeeperResult {
  agent_id: string;
  action: string;
  amount_fxrp: number;
  reason: string;
  position: PositionHealth;
}
interface KeeperView {
  results: KeeperResult[];
  summary: { evaluated: number; at_risk: number; by_status: Record<string, number> };
}
interface Automation {
  id: string;
  agent_id: string;
  name: string;
  trigger: { kind: string; price?: number; threshold?: number; every_seconds?: number };
  action: { kind: string; target_hf?: number; amount_fxrp?: number };
  enabled: boolean;
  fire_count: number;
  cron?: string;
  keeperhub_workflow_id?: string;
}
interface AutomationRun {
  automation_id: string;
  name: string;
  action: string;
  amount_fxrp?: number;
  reason: string;
  ok?: boolean;
  tx_hash?: string;
}
interface AutomationsView {
  automations: Automation[];
  last_runs: AutomationRun[];
}
interface CollateralLine {
  symbol: string;
  amount_whole: number;
  price_usd: number;
  price_source: string;
  value_usd: number;
  ltv_bps: number;
  borrowing_power_usd: number;
}
interface CollateralView {
  agent_id: string;
  valuation: { total_value_usd: number; borrowing_power_usd: number; lines: CollateralLine[] };
  position: { cap_usd: number; collateral_usd: number; borrowing_power_usd: number; health_factor: number; status: string; debt_usd: number };
}
interface FAssetsView {
  agent_id: string;
  fxrp_balance: number;
  total_supply: number;
  fdc_live: boolean;
  reservations: Array<{ reservation_id: string; underlying_drops: string; fxrp_amount: string; status: string }>;
}
interface SchedulerView {
  started: boolean;
  jobs: Array<{ name: string; interval_sec: number; enabled: boolean; running: boolean; runs: number }>;
  recent_runs: Array<{ job: string; ok: boolean; summary?: string }>;
}

export function Flare() {
  const [view, setView] = useState<FlareView | null>(null);
  const [keeper, setKeeper] = useState<KeeperView | null>(null);
  const [autos, setAutos] = useState<AutomationsView | null>(null);
  const [collat, setCollat] = useState<CollateralView | null>(null);
  const [fassets, setFassets] = useState<FAssetsView | null>(null);
  const [sched, setSched] = useState<SchedulerView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => {
    fetch("/api/flare")
      .then((r) => r.json())
      .then((b) => setView(b as FlareView))
      .catch(() => setView(null));
    fetch("/api/keeper")
      .then((r) => r.json())
      .then((b) => setKeeper(b as KeeperView))
      .catch(() => setKeeper(null));
    fetch("/api/automations")
      .then((r) => r.json())
      .then((b) => setAutos(b as AutomationsView))
      .catch(() => setAutos(null));
    fetch("/api/collateral")
      .then((r) => r.json())
      .then((b) => setCollat(b as CollateralView))
      .catch(() => setCollat(null));
    fetch("/api/fassets")
      .then((r) => r.json())
      .then((b) => setFassets(b as FAssetsView))
      .catch(() => setFassets(null));
    fetch("/api/scheduler")
      .then((r) => r.json())
      .then((b) => setSched(b as SchedulerView))
      .catch(() => setSched(null));
  };

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  const runLoop = async () => {
    setBusy(true);
    try {
      await fetch("/api/demo/flare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ amount_fxrp: 500 }) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runKeeper = async () => {
    setBusy(true);
    try {
      await fetch("/api/demo/keeper", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runAutomations = async () => {
    setBusy(true);
    try {
      await fetch("/api/demo/automations", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runCollateral = async () => {
    setBusy(true);
    try {
      await fetch("/api/demo/collateral", { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const runFassets = async () => {
    setBusy(true);
    try {
      await fetch("/api/demo/fassets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ xrp: 5000 }) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const schedulerAction = async (action: "tick" | "start" | "stop") => {
    setBusy(true);
    try {
      await fetch(`/api/scheduler/${action}`, { method: "POST" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!view) return <div className="empty">Loading Flare satellite…</div>;
  const { info, price, reliability, audit } = view;

  return (
    <div className="pool">
      <div className="stat-row">
        <Stat label="Network" value={info.network} accent />
        <Stat label="XRP / USD (FTSO)" value={`$${price.value} · ${price.source}`} />
        <Stat label="FXRP liquidity" value={`${(Number(info.liquidity_fxrp) / 1e6).toLocaleString()} FXRP`} />
        <Stat label="KeeperHub executions" value={`${reliability.total}`} />
      </div>

      <div className="card wide">
        <div className="onchain-head">
          <h3>Flare × KeeperHub — interoperable FXRP credit, FTSO-priced, KeeperHub-executed</h3>
          <button className="tab" onClick={runLoop} disabled={busy}>
            {busy ? "running…" : "Run FXRP credit loop ↻"}
          </button>
        </div>
        <div className="caps">
          <span className={`chip ${info.ftso_live ? "ok" : ""}`}>FTSO {info.ftso_live ? "live" : "sim"}</span>
          <span className={`chip ${info.keeperhub_live ? "ok" : ""}`}>KeeperHub {info.keeperhub_live ? "live" : "sim"}</span>
          <span className="chip">private routing {reliability.private_routed}/{reliability.total}</span>
          <span className="chip">avg gas backoff {reliability.avg_backoff_attempts}</span>
          {Object.entries(reliability.by_protocol).map(([p, n]) => (
            <span key={p} className="chip ok">
              {p}: {n}
            </span>
          ))}
          <a className="chain-pill" href={info.explorer} target="_blank" rel="noreferrer">
            ⛓ {info.chain} · pool {info.pool.slice(0, 10)}… ↗
          </a>
        </div>
      </div>

      <div className="card wide">
        <div className="onchain-head">
          <h3>Autonomous Scheduler — the last mile, on a cadence</h3>
          <div>
            <button className="tab" onClick={() => schedulerAction("tick")} disabled={busy}>
              run one tick ▶
            </button>{" "}
            {sched?.started ? (
              <button className="tab" onClick={() => schedulerAction("stop")} disabled={busy}>
                stop ⏹
              </button>
            ) : (
              <button className="tab" onClick={() => schedulerAction("start")} disabled={busy}>
                start ↻
              </button>
            )}
          </div>
        </div>
        {!sched ? (
          <div className="empty">Loading scheduler…</div>
        ) : (
          <div className="caps">
            <span className={`chip ${sched.started ? "ok" : ""}`}>{sched.started ? "running" : "idle"}</span>
            {sched.jobs.map((j) => (
              <span key={j.name} className="chip">
                {j.name}: every {j.interval_sec}s · {j.runs} run(s){j.running ? " · ▶" : ""}
              </span>
            ))}
            {sched.recent_runs.slice(0, 3).map((r, i) => (
              <span key={i} className={`chip ${r.ok ? "ok" : "bad"}`}>
                {r.job}: {r.summary ?? "done"}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="card wide">
        <div className="onchain-head">
          <h3>FAssets — mint FXRP from attested XRP → collateralize</h3>
          <button className="tab" onClick={runFassets} disabled={busy}>
            {busy ? "running…" : "Mint 5,000 XRP → FXRP → collateral ↻"}
          </button>
        </div>
        {!fassets ? (
          <div className="empty">Loading FAssets…</div>
        ) : (
          <div className="caps">
            <span className="chip accent">FXRP balance {fassets.fxrp_balance.toLocaleString()}</span>
            <span className="chip">circulating {fassets.total_supply.toLocaleString()} FXRP</span>
            <span className={`chip ${fassets.fdc_live ? "ok" : ""}`}>FDC {fassets.fdc_live ? "live" : "sim"}</span>
            <span className="chip">{fassets.reservations.length} mint reservation(s)</span>
            <span className="chip">XRP → FDC-attested → FXRP 1:1 → FTSO-priced collateral</span>
          </div>
        )}
      </div>

      <div className="card wide">
        <div className="onchain-head">
          <h3>FTSO-priced collateral — expand borrowing power</h3>
          <button className="tab" onClick={runCollateral} disabled={busy}>
            {busy ? "running…" : "Post collateral & cure a margin call ↻"}
          </button>
        </div>
        {!collat ? (
          <div className="empty">Loading collateral…</div>
        ) : (
          <>
            <div className="caps">
              <span className="chip">cap ${collat.position.cap_usd.toLocaleString()}</span>
              <span className="chip ok">+ collateral ${collat.position.collateral_usd.toLocaleString()}</span>
              <span className="chip accent">= borrowing power ${collat.position.borrowing_power_usd.toLocaleString()}</span>
              <span className="chip">debt ${collat.position.debt_usd.toLocaleString()}</span>
              <span className={`chip ${collat.position.status === "healthy" ? "ok" : collat.position.status === "no_debt" ? "" : "bad"}`}>
                HF {collat.position.health_factor === null || !isFinite(collat.position.health_factor) ? "∞" : collat.position.health_factor.toFixed(2)} · {collat.position.status}
              </span>
            </div>
            {collat.valuation.lines.length > 0 && (
              <table className="table">
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Amount</th>
                    <th>FTSO price</th>
                    <th>Value (USD)</th>
                    <th>LTV</th>
                    <th>Borrowing power</th>
                  </tr>
                </thead>
                <tbody>
                  {collat.valuation.lines.map((l) => (
                    <tr key={l.symbol}>
                      <td>{l.symbol}</td>
                      <td>{l.amount_whole}</td>
                      <td>
                        ${l.price_usd.toLocaleString()} <span className="chip">{l.price_source}</span>
                      </td>
                      <td>${l.value_usd.toLocaleString()}</td>
                      <td>{l.ltv_bps / 100}%</td>
                      <td>${l.borrowing_power_usd.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="card wide">
        <div className="onchain-head">
          <h3>Autonomous Credit Keeper — FTSO position health → KeeperHub execution</h3>
          <button className="tab" onClick={runKeeper} disabled={busy}>
            {busy ? "running…" : "Simulate margin call → auto-deleverage ↻"}
          </button>
        </div>
        {!keeper ? (
          <div className="empty">Loading positions…</div>
        ) : (
          <>
            <div className="caps">
              <span className="chip">evaluated {keeper.summary.evaluated}</span>
              <span className={`chip ${keeper.summary.at_risk > 0 ? "bad" : "ok"}`}>at risk {keeper.summary.at_risk}</span>
              {Object.entries(keeper.summary.by_status).map(([s, n]) => (
                <span key={s} className="chip">
                  {s}: {n}
                </span>
              ))}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>FXRP debt</th>
                  <th>Debt (USD @ FTSO)</th>
                  <th>Health factor</th>
                  <th>Status</th>
                  <th>Keeper action</th>
                </tr>
              </thead>
              <tbody>
                {keeper.results
                  .filter((r) => r.position.fxrp_debt_whole > 0)
                  .map((r) => (
                    <tr key={r.agent_id}>
                      <td>{r.agent_id}</td>
                      <td>{r.position.fxrp_debt_whole.toLocaleString()} FXRP</td>
                      <td>${r.position.debt_usd.toLocaleString()}</td>
                      <td>{r.position.health_factor === null || !isFinite(r.position.health_factor) ? "∞" : r.position.health_factor.toFixed(2)}</td>
                      <td>
                        <span className={`chip ${r.position.status === "healthy" ? "ok" : r.position.status === "watch" ? "" : "bad"}`}>{r.position.status}</span>
                      </td>
                      <td>{r.action === "none" ? "—" : `deleverage ${r.amount_fxrp} FXRP`}</td>
                    </tr>
                  ))}
                {keeper.results.every((r) => r.position.fxrp_debt_whole === 0) && (
                  <tr>
                    <td colSpan={6} className="empty">
                      No open FXRP positions — run the keeper demo to open one and watch it auto-cure.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>

      <div className="card wide">
        <div className="onchain-head">
          <h3>Credit Automations — declare a policy, KeeperHub runs it</h3>
          <button className="tab" onClick={runAutomations} disabled={busy}>
            {busy ? "running…" : "Set up sample automations & run ↻"}
          </button>
        </div>
        {!autos || autos.automations.length === 0 ? (
          <div className="empty">
            No automations yet — click above to declare price/health-triggered credit rules and watch KeeperHub execute them.
          </div>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Trigger</th>
                  <th>Action</th>
                  <th>Fires</th>
                  <th>Enabled</th>
                  <th>KeeperHub</th>
                </tr>
              </thead>
              <tbody>
                {autos.automations.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{triggerLabel(a.trigger)}</td>
                    <td>{actionLabel(a.action)}</td>
                    <td>{a.fire_count}</td>
                    <td>
                      <span className={`chip ${a.enabled ? "ok" : ""}`}>{a.enabled ? "on" : "off"}</span>
                    </td>
                    <td>{a.keeperhub_workflow_id ? `wf ${a.keeperhub_workflow_id.slice(0, 8)}…` : a.cron ? `cron ${a.cron}` : "local"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {autos.last_runs.length > 0 && (
              <div className="caps" style={{ marginTop: 8 }}>
                {autos.last_runs.map((r, i) => (
                  <span key={i} className={`chip ${r.ok ? "ok" : "bad"}`}>
                    {r.name}: {r.action}
                    {r.amount_fxrp ? ` ${r.amount_fxrp} FXRP` : ""}
                  </span>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="card wide">
        <h3>KeeperHub audit trail — the last mile ({audit.length})</h3>
        {audit.length === 0 ? (
          <div className="empty">No executions yet — run the FXRP credit loop above.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Status</th>
                <th>Payment</th>
                <th>Private</th>
                <th>Backoff</th>
                <th>Gas used</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {audit
                .slice()
                .reverse()
                .map((a) => (
                  <tr key={a.audit_id}>
                    <td>{a.intent_kind}</td>
                    <td>
                      <span className={`chip ${a.status === "confirmed" ? "ok" : a.status === "failed" ? "bad" : ""}`}>{a.status}</span>
                    </td>
                    <td>
                      {a.payment.protocol} · {Number(a.payment.amount) / 1e6} {a.payment.asset}
                    </td>
                    <td>{a.private_routed ? "✓" : "—"}</td>
                    <td>{a.gas.attempts}</td>
                    <td>{a.gas_used ?? "—"}</td>
                    <td title={a.tx_hash}>{a.tx_hash ? `${a.tx_hash.slice(0, 12)}…` : "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function triggerLabel(t: Automation["trigger"]): string {
  switch (t.kind) {
    case "price_below":
      return `XRP/USD < $${t.price}`;
    case "price_above":
      return `XRP/USD > $${t.price}`;
    case "health_below":
      return `HF < ${t.threshold}`;
    case "schedule":
      return `every ${t.every_seconds}s`;
    default:
      return t.kind;
  }
}
function actionLabel(a: Automation["action"]): string {
  switch (a.kind) {
    case "deleverage":
      return `deleverage → HF ${a.target_hf ?? 2.0}`;
    case "repay":
      return `repay ${a.amount_fxrp} FXRP`;
    default:
      return a.kind;
  }
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
