/**
 * CasperLiveBridge — the real write path behind the console's "mutation"
 * endpoints (register/stake/score/deposit), mirroring onto the ACTUAL Casper
 * Testnet contracts in `deploys.testnet.json` whenever the service is
 * configured for live mode (see {@link readCasperEnv}).
 *
 * Design constraints that shaped this file:
 *
 *  1. The in-memory {@link Ledger} (lib/ledger) is the system of record for the
 *     console's fast demo loop (hundreds of simulated events/sec in some demo
 *     scenes). Mirroring EVERY sim mutation onto chain would spam a funded
 *     Testnet account and get rate-limited in minutes. Instead this bridge is
 *     called only from the explicit, user/API-triggered mutation points
 *     (api/state.ts `mRegisterAgent` / `mStake` / `mDeposit`, and
 *     agents/credit_agent.ts `underwrite` for `set_credit_score`) — the actions
 *     a real integrator actually clicks or calls once, not the background
 *     economy tick.
 *
 *  2. `register_agent` is a plain, non-payable, non-admin-gated entry point —
 *     this is the highest-confidence live call and the one every other write
 *     depends on (an agent must exist on-chain before `stake` will accept it).
 *
 *  3. `set_credit_score` is `only_admin`-gated on-chain: it reverts unless the
 *     signing key is the ORIGINAL deployer key that installed AgentRegistry
 *     (`deployer_public_key` in deploys.testnet.json). A freshly generated
 *     operator key can never pass this call — that is flagged in the result
 *     (`admin_required: true`), not hidden.
 *
 *  4. `stake` / `deposit_liquidity` are `#[odra(payable)]` — the attached CSPR
 *     is read via `self.env().attached_value()`. This bridge submits the
 *     payment as a plain "amount" U512 runtime arg on a direct
 *     StoredContractByHash call (the same convention the sim-side
 *     {@link CasperTransport} abstraction already uses in `ledger_transport.ts`).
 *     Whether Odra's casper-backend WASM for a payable entry point reads that
 *     as the attached value, or requires its own proxy-caller session instead,
 *     is NOT yet verified against a funded account. Every payable mirror result
 *     therefore carries `convention_verified: false` until a real funded call
 *     is confirmed on cspr.live — report it honestly, don't hide the gap.
 */
import deploysTestnet from "../../deploys.testnet.json" with { type: "json" };
import { readCasperEnv, createLiveTransport, isLiveConfigured, type CasperEnv } from "./factory.js";
import { buildContractCall, type DeploySpec } from "./deploy.js";
import { arg } from "./args.js";
import type { CasperTransport } from "./transport.js";
import { cspr } from "../core/units.js";

interface ContractManifestEntry {
  crate: string;
  name: string;
  contract_hash: string;
  status: string;
}

const MANIFEST = deploysTestnet as {
  chain: string;
  node: string;
  deployer_public_key: string;
  explorer: string;
  contracts: ContractManifestEntry[];
};

function contractHash(name: string): string {
  const entry = MANIFEST.contracts.find((c) => c.name === name);
  if (!entry) throw new Error(`no installed contract named ${name} in deploys.testnet.json`);
  return entry.contract_hash;
}

/** Default gas budget per call — Casper refunds unused payment automatically. */
const DEFAULT_PAYMENT_MOTES = 3_000_000_000n; // 3 CSPR

export type LiveMirrorResult =
  | { mode: "sim"; reason: string }
  | {
      mode: "live";
      deploy_hash: string;
      explorer_url: string;
      status: "submitted";
      convention_verified: boolean;
      admin_required?: boolean;
    }
  | { mode: "live-error"; error: string; admin_required?: boolean };

/** `hash-...` → the cspr.live deploy explorer URL for that transaction. */
function deployExplorerUrl(deployHash: string): string {
  const base = MANIFEST.explorer.replace(/\/$/, "");
  return `${base}/deploy/${deployHash}`;
}

export interface LiveMirrorLogEntry {
  at: number;
  op: "register_agent" | "stake" | "set_credit_score" | "deposit_liquidity";
  agent_id?: string;
  result: LiveMirrorResult;
}

const LOG_CAP = 50;

export class CasperLiveBridge {
  private transport: CasperTransport | undefined;
  private transportError: string | undefined;
  private initPromise: Promise<void> | undefined;
  readonly env: CasperEnv;
  /** Agent ids this process has itself live-registered — stake only ever
   *  succeeds on-chain for an agent that already exists there. */
  private readonly liveRegistered = new Set<string>();
  /** Every mirror attempt (sim-skip, live-submit or live-error), newest last —
   *  the "Casper Live" console panel reads this so background mirrors (e.g.
   *  the fire-and-forget `set_credit_score` call from the underwriter) are
   *  still visible, not just the ones returned inline from an HTTP response. */
  private readonly log: LiveMirrorLogEntry[] = [];

  constructor(env: CasperEnv = readCasperEnv()) {
    this.env = env;
  }

  private record(op: LiveMirrorLogEntry["op"], agent_id: string | undefined, result: LiveMirrorResult): LiveMirrorResult {
    this.log.push({ at: Date.now(), op, agent_id, result });
    if (this.log.length > LOG_CAP) this.log.shift();
    return result;
  }

  /** Recent mirror attempts for the console's "Casper Live" panel, newest first. */
  recentActivity(limit = 20): LiveMirrorLogEntry[] {
    return this.log.slice(-limit).reverse();
  }

  get live(): boolean {
    return isLiveConfigured(this.env);
  }

  private async transportOrThrow(): Promise<CasperTransport> {
    if (this.transport) return this.transport;
    if (this.transportError) throw new Error(this.transportError);
    if (!this.initPromise) {
      this.initPromise = createLiveTransport(this.env)
        .then((t) => {
          this.transport = t;
        })
        .catch((err) => {
          this.transportError = (err as Error).message;
        });
    }
    await this.initPromise;
    if (this.transport) return this.transport;
    throw new Error(this.transportError ?? "live transport unavailable");
  }

  private senderHex(): string {
    // The signer derives its own public key from the PEM; the deploy header's
    // "sender" field here is informational only for buildContractCall — the
    // SDK signer sets the real header public key itself at sign time.
    return this.env.secretKeyPem ? "pem-configured" : (this.env.secretKeyPath ?? "unconfigured");
  }

  private async submit(spec: DeploySpec): Promise<LiveMirrorResult & { mode: "live" | "live-error" }> {
    try {
      const transport = await this.transportOrThrow();
      const result = await transport.callEntryPoint(spec);
      if (result.status === "failure") {
        return { mode: "live-error", error: result.errorMessage ?? "deploy failed" };
      }
      return {
        mode: "live",
        deploy_hash: result.deployHash,
        explorer_url: deployExplorerUrl(result.deployHash),
        status: "submitted",
        convention_verified: spec.entryPoint === "register_agent",
      };
    } catch (err) {
      return { mode: "live-error", error: (err as Error).message };
    }
  }

  /** Mirror a new agent's identity onto the real AgentRegistry contract. */
  async mirrorRegisterAgent(opts: { agentId: string; serviceType: string; agentPublicKeyHex: string }): Promise<LiveMirrorResult> {
    if (!this.live) {
      return this.record("register_agent", opts.agentId, { mode: "sim", reason: "CRED402_CASPER_SECRET_KEY_PEM / CRED402_CASPER_NODE_URL not set" });
    }
    const spec = buildContractCall({
      contractHash: contractHash("AgentRegistry"),
      entryPoint: "register_agent",
      args: [
        arg.string("agent_id", opts.agentId),
        arg.string("service_type", opts.serviceType),
        arg.string("agent_public_key", opts.agentPublicKeyHex || "00"),
      ],
      paymentMotes: DEFAULT_PAYMENT_MOTES,
      chainName: this.env.chainName,
      sender: this.senderHex(),
    });
    const result = await this.submit(spec);
    if (result.mode === "live") this.liveRegistered.add(opts.agentId);
    return this.record("register_agent", opts.agentId, result);
  }

  /** Mirror a stake (attached-value `stake(agent_id)`) onto AgentRegistry. */
  async mirrorStake(opts: { agentId: string; amountCspr: number }): Promise<LiveMirrorResult> {
    if (!this.live) {
      return this.record("stake", opts.agentId, { mode: "sim", reason: "CRED402_CASPER_SECRET_KEY_PEM / CRED402_CASPER_NODE_URL not set" });
    }
    if (!this.liveRegistered.has(opts.agentId)) {
      return this.record("stake", opts.agentId, {
        mode: "live-error",
        error: `${opts.agentId} was never live-registered on AgentRegistry in this process — stake would revert (agent not found on-chain)`,
      });
    }
    const amountMotes = cspr(opts.amountCspr);
    const spec = buildContractCall({
      contractHash: contractHash("AgentRegistry"),
      entryPoint: "stake",
      args: [arg.string("agent_id", opts.agentId), arg.u512("amount", amountMotes)],
      paymentMotes: DEFAULT_PAYMENT_MOTES + amountMotes,
      chainName: this.env.chainName,
      sender: this.senderHex(),
    });
    return this.record("stake", opts.agentId, await this.submit(spec));
  }

  /** Mirror `set_credit_score(agent_id, score)` — admin-only on-chain. */
  async mirrorSetCreditScore(opts: { agentId: string; score: number }): Promise<LiveMirrorResult> {
    if (!this.live) {
      return this.record("set_credit_score", opts.agentId, { mode: "sim", reason: "CRED402_CASPER_SECRET_KEY_PEM / CRED402_CASPER_NODE_URL not set" });
    }
    const spec = buildContractCall({
      contractHash: contractHash("AgentRegistry"),
      entryPoint: "set_credit_score",
      args: [arg.string("agent_id", opts.agentId), arg.u64("score", Math.max(0, Math.min(100, Math.round(opts.score))))],
      paymentMotes: DEFAULT_PAYMENT_MOTES,
      chainName: this.env.chainName,
      sender: this.senderHex(),
    });
    const result = await this.submit(spec);
    const final: LiveMirrorResult =
      result.mode === "live-error"
        ? { ...result, admin_required: true, error: `${result.error} (set_credit_score is admin-gated on-chain; the signing key must be the original deployer ${MANIFEST.deployer_public_key.slice(0, 16)}…)` }
        : { ...result, admin_required: false };
    return this.record("set_credit_score", opts.agentId, final);
  }

  /** Mirror `deposit_liquidity()` (attached-value) onto AgentCreditPool. */
  async mirrorDepositLiquidity(opts: { amountCspr: number }): Promise<LiveMirrorResult> {
    if (!this.live) {
      return this.record("deposit_liquidity", undefined, { mode: "sim", reason: "CRED402_CASPER_SECRET_KEY_PEM / CRED402_CASPER_NODE_URL not set" });
    }
    const amountMotes = cspr(opts.amountCspr);
    const spec = buildContractCall({
      contractHash: contractHash("AgentCreditPool"),
      entryPoint: "deposit_liquidity",
      args: [arg.u512("amount", amountMotes)],
      paymentMotes: DEFAULT_PAYMENT_MOTES + amountMotes,
      chainName: this.env.chainName,
      sender: this.senderHex(),
    });
    return this.record("deposit_liquidity", undefined, await this.submit(spec));
  }

  /** Live node health — reachability only, independent of whether a key is configured. */
  async health(): Promise<{ configured: boolean; reachable: boolean; chain?: string }> {
    if (!this.live) return { configured: false, reachable: false };
    try {
      const transport = await this.transportOrThrow();
      const h = await transport.health();
      return { configured: true, reachable: h.ok, chain: h.chain };
    } catch {
      return { configured: true, reachable: false };
    }
  }
}

/** Process-wide singleton — one bridge, one transport, one env read. */
let _bridge: CasperLiveBridge | undefined;
export function casperLiveBridge(): CasperLiveBridge {
  if (!_bridge) _bridge = new CasperLiveBridge();
  return _bridge;
}
