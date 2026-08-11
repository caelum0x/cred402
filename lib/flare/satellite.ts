import type { Ledger } from "../ledger/ledger.js";
import {
  FlareAdapter,
  FlareSatelliteVault,
  FtsoPriceClient,
  resolveFlareNetwork,
  flareTxUrl,
  FXRP,
  fxrpToXrp,
  type FlareNetwork,
} from "../../packages/chain-adapters/src/index.js";
import { KeeperHubExecutor } from "../keeperhub/index.js";
import type { AuditRecord } from "../keeperhub/index.js";
import { CollateralVault } from "./collateral.js";

/**
 * FlareCreditSatellite — the one place that wires a Cred402 ledger to the Flare
 * satellite so MCP, the REST API and scripts all share identical behavior:
 *
 *   Casper issues a CAN (USD-denominated, global-exposure-checked)
 *     → the Flare vault lends FXRP, priced by FTSO
 *       → KeeperHub executes the on-chain draw (sim/gas-backoff/private/audit)
 *
 * Everything degrades to a deterministic sim with no keys; set FLARE_RPC_URL /
 * KEEPERHUB_API_KEY to light up the real FTSO reads and real KeeperHub execution.
 */

const DEFAULT_POOL = process.env.FLARE_VAULT_ADDRESS ?? "0xf1a5e0" + "0".repeat(34);
const DEFAULT_LIQUIDITY_FXRP = 5_000_000n * 1_000_000n; // 5,000,000 FXRP (6 dp)
const DEFAULT_EXPOSURE_CAP_USD = 5_000_000_000n; // $5,000 global cap (USD micro)

export interface FlareSatelliteConfig {
  /** Network key / CAIP-2 / chain id. Default Coston2 (or FLARE_NETWORK env). */
  network?: string;
  poolAddress?: string;
  initialLiquidityFxrp?: bigint;
  /** Route execution through KeeperHub. Default true. */
  useKeeperHub?: boolean;
  ftso?: FtsoPriceClient;
  executor?: KeeperHubExecutor;
  /** Inject a persistent collateral vault (so posted collateral survives a ledger reset). */
  collateral?: CollateralVault;
}

export interface FlareDrawSummary {
  ok: boolean;
  agent_id: string;
  asset: "FXRP";
  amount_fxrp: string;
  amount_xrp: number;
  usd_value: number;
  xrp_usd: number;
  price_source: string;
  note_id: string;
  tx_hash: string;
  explorer_url: string;
  vault_liquidity_fxrp: string;
  keeperhub: {
    executed: boolean;
    live: boolean;
    audit?: AuditRecord;
  };
  detail?: string;
}

export class FlareCreditSatellite {
  readonly network: FlareNetwork;
  readonly vault: FlareSatelliteVault;
  readonly executor: KeeperHubExecutor;
  readonly adapter: FlareAdapter;
  /** FTSO-priced multi-asset collateral posted against this agent's credit line. */
  readonly collateral: CollateralVault;
  private readonly ftso: FtsoPriceClient;
  private readonly useKeeperHub: boolean;

  constructor(
    private readonly ledger: Ledger,
    cfg: FlareSatelliteConfig = {},
  ) {
    this.network = resolveFlareNetwork(cfg.network ?? process.env.FLARE_NETWORK);
    this.ftso = cfg.ftso ?? new FtsoPriceClient();
    this.executor = cfg.executor ?? new KeeperHubExecutor();
    this.useKeeperHub = cfg.useKeeperHub !== false;
    const pool = cfg.poolAddress ?? DEFAULT_POOL;
    this.vault = new FlareSatelliteVault(
      this.network.caip2,
      pool,
      ledger.policyPublicKeyHex,
      cfg.initialLiquidityFxrp ?? DEFAULT_LIQUIDITY_FXRP,
      this.ftso,
    );
    this.adapter = new FlareAdapter(this.network.caip2, this.vault, {
      executor: this.useKeeperHub ? this.executor : undefined,
      clock: () => ledger.clock.now(),
    });
    this.collateral = cfg.collateral ?? new CollateralVault(this.ftso);
  }

  /** The shared FTSO price client (so the keeper prices positions off the same feed). */
  get priceClient(): FtsoPriceClient {
    return this.ftso;
  }

  /** Live FTSO XRP/USD price (or the deterministic sim reference). */
  async xrpUsd(): Promise<{ value: number; source: string }> {
    const p = await this.ftso.getPrice(FXRP.ftso_feed);
    return { value: p.value, source: p.source };
  }

  /**
   * Draw `amountFxrp` (FXRP smallest units) for an agent: reserve global exposure,
   * mint a Casper-signed CAN sized to the FTSO-priced USD value, then let the
   * FlareAdapter execute the draw through KeeperHub.
   */
  async draw(agentId: string, amountFxrp: bigint, opts: { exposureCapUsd?: bigint } = {}): Promise<FlareDrawSummary> {
    const agent = this.ledger.agents.get(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);

    // Price the intended draw in USD so the CAN authorizes the right USD limit.
    const price = await this.ftso.getPrice(FXRP.ftso_feed);
    const usdMicro = BigInt(Math.ceil(fxrpToXrp(amountFxrp) * price.value * 1e6));

    this.ledger.exposure.ensure_agent(agentId, opts.exposureCapUsd ?? DEFAULT_EXPOSURE_CAP_USD);
    const can = this.ledger.notes.issue_can({
      agent_id: agentId,
      credit_score: Math.max(agent.credit_score, 1),
      risk_policy_version: Number(this.ledger.policy.version().replace(/\D/g, "")) || 1,
      target_chain: this.network.caip2,
      target_pool: this.vault.poolAddress,
      max_draw: usdMicro,
      asset: FXRP.symbol,
    });

    const res = await this.adapter.drawCredit({ note: can, agent_id: agentId, amount: amountFxrp.toString() });
    // Reconcile the Casper-rooted global exposure in USD micro (this path runs no
    // relayer): the CAN reserved `usdMicro`; activate it on success, release it on
    // failure so a rolled-back draw never strands the agent's cross-chain cap.
    if (res.ok) this.ledger.exposure.activate_exposure(agentId, usdMicro);
    else this.ledger.exposure.release_reservation(agentId, usdMicro);
    const audit = this.useKeeperHub ? this.executor.auditTrail().at(-1) : undefined;

    return {
      ok: res.ok,
      agent_id: agentId,
      asset: "FXRP",
      amount_fxrp: amountFxrp.toString(),
      amount_xrp: fxrpToXrp(amountFxrp),
      usd_value: Number(usdMicro) / 1e6,
      xrp_usd: price.value,
      price_source: price.source,
      note_id: can.note_id,
      tx_hash: res.tx_hash,
      explorer_url: res.tx_hash ? flareTxUrl(this.network, res.tx_hash) : "",
      vault_liquidity_fxrp: this.vault.availableLiquidity().toString(),
      keeperhub: { executed: this.useKeeperHub, live: this.executor.isLive(), audit },
      detail: res.detail,
    };
  }

  /** Repay FXRP debt; also executed through KeeperHub when enabled. Releases the
   * agent's global exposure in USD micro (the denominator it was reserved in). */
  async repay(agentId: string, amountFxrp: bigint): Promise<{ ok: boolean; tx_hash: string; explorer_url: string }> {
    const debtBefore = this.vault.debtOf(agentId);
    const res = await this.adapter.repayCredit({ agent_id: agentId, amount: amountFxrp.toString() });
    if (res.ok && debtBefore > 0n) {
      const exposure = this.ledger.exposure.get_agent_global_exposure(agentId);
      if (exposure && exposure.outstanding > 0n) {
        // Release the PROPORTIONAL share of the USD exposure the repaid FXRP represents:
        // repaying fraction f of the FXRP debt releases f × outstanding. This is
        // price-independent, so a post-draw XRP price move can never over- or
        // under-release the shared cross-chain cap, and an over-repay (amount > owed)
        // is capped at the debt actually paid.
        const paid = amountFxrp > debtBefore ? debtBefore : amountFxrp;
        const release = (exposure.outstanding * paid) / debtBefore;
        this.ledger.exposure.decrease_exposure(agentId, release);
      }
    }
    return { ok: res.ok, tx_hash: res.tx_hash, explorer_url: res.tx_hash ? flareTxUrl(this.network, res.tx_hash) : "" };
  }

  /** KeeperHub reliability summary for the console / API. */
  reliability() {
    return this.executor.reliability();
  }

  auditTrail(agentId?: string): AuditRecord[] {
    return agentId ? this.executor.auditFor(agentId) : this.executor.auditTrail();
  }

  info() {
    return {
      network: this.network.name,
      chain: this.network.caip2,
      explorer: this.network.explorer,
      pool: this.vault.poolAddress,
      asset: FXRP.symbol,
      liquidity_fxrp: this.vault.availableLiquidity().toString(),
      ftso_live: this.ftso.isLive(),
      keeperhub_live: this.executor.isLive(),
      keeperhub_enabled: this.useKeeperHub,
    };
  }
}
