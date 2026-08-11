import type { Ledger } from "../ledger/ledger.js";
import { blake2b256 } from "../core/hash.js";
import { KeeperHubClient } from "../keeperhub/client.js";
import type { FlareCreditSatellite } from "./satellite.js";
import { PositionEngine, type PositionHealth } from "./positions.js";

/**
 * Credit Automations — set-and-forget credit rules, executed reliably by KeeperHub.
 *
 * The Autonomous Credit Keeper reacts to a margin call; automations let an agent (or
 * operator) declare its OWN policy up front — "if XRP/USD crosses $0.80, deleverage
 * my FXRP position to a 2.0 health factor", "every hour, sweep and repay", "if my
 * health factor drops below 1.4, alert me" — and have KeeperHub run it on a schedule
 * or on a price trigger. This is exactly KeeperHub's workflow + cron +
 * check-and-execute surface: a declarative trigger → an on-chain action, executed
 * with simulation, smart gas, private routing and an audit trail.
 *
 * The local engine is the source of truth and executes every action through the
 * FlareCreditSatellite (→ KeeperHub). When a real KEEPERHUB_API_KEY is present, each
 * automation is ALSO registered as a KeeperHub workflow (create_workflow, with a
 * validated cron for schedule triggers) so it can be scheduled/managed there.
 */

export type AutomationTrigger =
  | { kind: "price_below"; price: number }
  | { kind: "price_above"; price: number }
  | { kind: "health_below"; threshold: number }
  | { kind: "schedule"; every_seconds: number };

export type AutomationAction =
  | { kind: "deleverage"; target_hf?: number }
  | { kind: "repay"; amount_fxrp: number }
  | { kind: "notify" };

export interface AutomationDef {
  agent_id: string;
  name: string;
  trigger: AutomationTrigger;
  action: AutomationAction;
  /** Minimum seconds between fires for threshold triggers (anti-spam). Default 60. */
  cooldown_seconds?: number;
}

export interface Automation extends AutomationDef {
  id: string;
  enabled: boolean;
  created_at: number;
  last_fired_at?: number;
  fire_count: number;
  /** Cron expression rendered for KeeperHub (schedule triggers only). */
  cron?: string;
  /** KeeperHub workflow id when registered on the real MCP server. */
  keeperhub_workflow_id?: string;
}

export interface AutomationRun {
  automation_id: string;
  agent_id: string;
  name: string;
  fired: boolean;
  reason: string;
  action: string;
  amount_fxrp?: number;
  ok?: boolean;
  tx_hash?: string;
  explorer_url?: string;
  keeperhub_audit_id?: string;
  at: number;
}

export interface AutomationTickContext {
  satellite: FlareCreditSatellite;
  ledger: Ledger;
  now?: number;
}

const DEFAULT_TARGET_HF = 2.0;

export class AutomationEngine {
  private readonly automations = new Map<string, Automation>();
  private seq = 0;

  /** Serializes overlapping tick() calls so a rule can never double-execute. */
  private tickChain: Promise<AutomationRun[]> = Promise.resolve([]);

  constructor(
    private readonly client: KeeperHubClient = new KeeperHubClient(),
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  /** Register a new automation; also registers a KeeperHub workflow when live. */
  async register(def: AutomationDef): Promise<Automation> {
    validateAutomationDef(def); // reject unknown/incomplete triggers or actions up front
    this.seq += 1;
    const id = "auto-" + blake2b256(`${def.agent_id}:${def.name}:${this.seq}`).slice(2, 14);
    const cron = def.trigger.kind === "schedule" ? everySecondsToCron(def.trigger.every_seconds) : undefined;
    const keeperhub_workflow_id = await this.registerWorkflow(def, cron);
    const automation: Automation = {
      ...def,
      id,
      enabled: true,
      created_at: this.clock(),
      fire_count: 0,
      cron,
      keeperhub_workflow_id,
    };
    this.automations.set(id, automation);
    return automation;
  }

  list(agentId?: string): Automation[] {
    const all = [...this.automations.values()];
    return (agentId ? all.filter((a) => a.agent_id === agentId) : all).map((a) => ({ ...a }));
  }

  get(id: string): Automation | undefined {
    const a = this.automations.get(id);
    return a ? { ...a } : undefined;
  }

  remove(id: string): boolean {
    return this.automations.delete(id);
  }

  /** Enable/disable immutably — returns the updated automation or undefined. */
  setEnabled(id: string, enabled: boolean): Automation | undefined {
    const a = this.automations.get(id);
    if (!a) return undefined;
    const next = { ...a, enabled };
    this.automations.set(id, next);
    return { ...next };
  }

  /**
   * Evaluate every enabled automation against live FTSO + position state and execute
   * the ones whose trigger is due. Returns one run record per due automation.
   *
   * Ticks are SERIALIZED: an overlapping tick() waits for the in-flight one, so a
   * rule can never double-execute across the assess()/repay() await points.
   */
  async tick(ctx: AutomationTickContext): Promise<AutomationRun[]> {
    const run = this.tickChain.then(
      () => this.tickOnce(ctx),
      () => this.tickOnce(ctx),
    );
    this.tickChain = run.catch(() => []);
    return run;
  }

  private async tickOnce(ctx: AutomationTickContext): Promise<AutomationRun[]> {
    const now = ctx.now ?? this.clock();
    const engine = new PositionEngine(ctx.satellite.vault, ctx.ledger, ctx.satellite.priceClient, {}, ctx.satellite.collateral);
    const runs: AutomationRun[] = [];
    for (const auto of [...this.automations.values()]) {
      // Re-read live state each iteration so a concurrent enable/disable/remove that
      // landed during a prior await is honored, not clobbered by a stale snapshot.
      const live = this.automations.get(auto.id);
      if (!live || !live.enabled) continue;
      const position = await engine.assess(live.agent_id);
      const check = this.isDue(live, position, now);
      if (!check.due) continue;
      const run = await this.execute(live, ctx.satellite, engine, position, now, check.reason);
      runs.push(run);
      // Re-read again before writeback (execute() awaited) so we never resurrect a
      // removed automation or overwrite a concurrent enable/disable.
      const current = this.automations.get(live.id);
      if (current) this.automations.set(current.id, { ...current, last_fired_at: now, fire_count: current.fire_count + 1 });
    }
    return runs;
  }

  // -- internals -----------------------------------------------------------

  private isDue(auto: Automation, position: PositionHealth, now: number): { due: boolean; reason: string } {
    const cooldown = auto.trigger.kind === "schedule" ? auto.trigger.every_seconds : auto.cooldown_seconds ?? 60;
    if (auto.last_fired_at !== undefined && now - auto.last_fired_at < cooldown) {
      return { due: false, reason: "cooldown" };
    }
    switch (auto.trigger.kind) {
      case "schedule":
        return {
          due: auto.last_fired_at === undefined || now - auto.last_fired_at >= auto.trigger.every_seconds,
          reason: `schedule: every ${auto.trigger.every_seconds}s`,
        };
      case "price_below":
        return { due: position.xrp_usd < auto.trigger.price, reason: `FTSO XRP/USD $${position.xrp_usd} < $${auto.trigger.price}` };
      case "price_above":
        return { due: position.xrp_usd > auto.trigger.price, reason: `FTSO XRP/USD $${position.xrp_usd} > $${auto.trigger.price}` };
      case "health_below":
        return {
          due: position.fxrp_debt !== "0" && isFinite(position.health_factor) && position.health_factor < auto.trigger.threshold,
          reason: `health factor ${fmt(position.health_factor)} < ${auto.trigger.threshold}`,
        };
      default:
        // Defense in depth — register() rejects unknown kinds, but never throw on tick.
        return { due: false, reason: "unknown trigger kind" };
    }
  }

  private async execute(
    auto: Automation,
    satellite: FlareCreditSatellite,
    engine: PositionEngine,
    position: PositionHealth,
    now: number,
    reason: string,
  ): Promise<AutomationRun> {
    const base = { automation_id: auto.id, agent_id: auto.agent_id, name: auto.name, fired: true, reason, at: now };
    try {
      if (auto.action.kind === "notify") {
        return { ...base, action: "notify" };
      }
      let amountFxrp: number;
      if (auto.action.kind === "deleverage") {
        const { deleverage_fxrp } = await engine.deleverageToTarget(auto.agent_id, auto.action.target_hf ?? DEFAULT_TARGET_HF);
        amountFxrp = deleverage_fxrp;
        if (amountFxrp <= 0) {
          return { ...base, action: "deleverage", amount_fxrp: 0, ok: true, reason: `${reason}; already at/above target HF — no repay needed` };
        }
      } else {
        amountFxrp = Math.min(auto.action.amount_fxrp, position.fxrp_debt_whole);
        if (amountFxrp <= 0) return { ...base, action: "repay", amount_fxrp: 0, ok: true, reason: `${reason}; no FXRP debt to repay` };
      }
      const res = await satellite.repay(auto.agent_id, BigInt(Math.round(amountFxrp * 1e6)));
      const audit = satellite.auditTrail(auto.agent_id).at(-1);
      return {
        ...base,
        action: auto.action.kind,
        amount_fxrp: amountFxrp,
        ok: res.ok,
        tx_hash: res.tx_hash,
        explorer_url: res.explorer_url,
        keeperhub_audit_id: audit?.audit_id,
      };
    } catch (err) {
      return { ...base, action: auto.action.kind, ok: false, reason: `${reason}; error: ${(err as Error).message}` };
    }
  }

  /** Best-effort registration of the automation as a KeeperHub workflow. */
  private async registerWorkflow(def: AutomationDef, cron?: string): Promise<string | undefined> {
    if (!this.client.isLive()) return undefined;
    try {
      if (cron) await this.client.callTool("validate_cron", { expression: cron }).catch(() => undefined);
      const wf = (await this.client.callTool("create_workflow", {
        name: `cred402:${def.name}`,
        description: `Cred402 credit automation for ${def.agent_id}: on ${triggerLabel(def.trigger)} → ${actionLabel(def.action)}`,
        enabled: false, // registered but driven by Cred402's tick; enable in KeeperHub to schedule
        ...(cron ? { cron } : {}),
      })) as { id?: string; workflow_id?: string };
      return wf.id ?? wf.workflow_id;
    } catch {
      return undefined; // keep the automation local-only
    }
  }
}

/** Validate a def before registration — reject unknown or incomplete triggers/actions. */
function validateAutomationDef(def: AutomationDef): void {
  const pos = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n > 0;
  const t = def.trigger;
  switch (t.kind) {
    case "price_below":
    case "price_above":
      if (!pos(t.price)) throw new Error(`${t.kind} requires a positive 'price'`);
      break;
    case "health_below":
      if (!pos(t.threshold)) throw new Error("health_below requires a positive 'threshold'");
      break;
    case "schedule":
      if (!(typeof t.every_seconds === "number" && Number.isFinite(t.every_seconds) && t.every_seconds >= 1)) {
        throw new Error("schedule requires 'every_seconds' >= 1");
      }
      break;
    default:
      throw new Error(`unknown trigger kind: ${(t as { kind: string }).kind}`);
  }
  const a = def.action;
  switch (a.kind) {
    case "deleverage":
      if (a.target_hf !== undefined && !pos(a.target_hf)) throw new Error("deleverage 'target_hf' must be positive");
      break;
    case "repay":
      if (!pos(a.amount_fxrp)) throw new Error("repay requires a positive 'amount_fxrp'");
      break;
    case "notify":
      break;
    default:
      throw new Error(`unknown action kind: ${(a as { kind: string }).kind}`);
  }
}

/**
 * Render a schedule interval to the closest standard 5-field cron for KeeperHub.
 * Cron granularity is one minute, so sub-minute intervals map to every-minute; whole
 * hours use the hour field; longer intervals map to daily.
 */
function everySecondsToCron(everySeconds: number): string {
  if (everySeconds < 60) return "* * * * *"; // every minute (cron's finest granularity)
  if (everySeconds < 3600) {
    const minutes = Math.min(59, Math.max(1, Math.round(everySeconds / 60)));
    return `*/${minutes} * * * *`;
  }
  if (everySeconds < 86400) {
    const hours = Math.min(23, Math.max(1, Math.round(everySeconds / 3600)));
    return `0 */${hours} * * *`;
  }
  return "0 0 * * *"; // daily
}
function triggerLabel(t: AutomationTrigger): string {
  switch (t.kind) {
    case "price_below":
      return `XRP/USD < $${t.price}`;
    case "price_above":
      return `XRP/USD > $${t.price}`;
    case "health_below":
      return `health factor < ${t.threshold}`;
    case "schedule":
      return `every ${t.every_seconds}s`;
  }
}
function actionLabel(a: AutomationAction): string {
  switch (a.kind) {
    case "deleverage":
      return `deleverage to HF ${a.target_hf ?? DEFAULT_TARGET_HF}`;
    case "repay":
      return `repay ${a.amount_fxrp} FXRP`;
    case "notify":
      return "notify";
  }
}
function fmt(hf: number): string {
  return hf === Infinity ? "∞" : hf.toFixed(2);
}
