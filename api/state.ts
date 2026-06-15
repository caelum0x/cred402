import { Ledger, EventBus, Clock } from "../lib/ledger/index.js";
import { Cred402Economy, type StepLog } from "../agents/economy.js";
import { FraudService } from "../lib/services/fraud_service.js";
import { generateEvmKeypair, type PaymentChallenge } from "../lib/x402/index.js";
import { buildAddressBinding, buildUniversalReceipt } from "../crosschain/standards/index.js";
import { CasperAdapter, EvmAdapter, EvmSatelliteVault } from "../packages/chain-adapters/src/index.js";
import { RealFiBridge } from "../lib/services/realfi_bridge.js";
import { Marketplace } from "../lib/services/marketplace.js";
import { ProtocolEconomics } from "../lib/core/economics.js";
import { cspr, formatCspr } from "../lib/core/units.js";
import { loadConfig, LedgerJournal } from "../lib/gateway/index.js";
import { ComplianceService } from "../lib/compliance/service.js";

/**
 * Server state — one persistent ledger + economy shared across all HTTP requests
 * so the dashboard reflects live on-chain state. Pending x402 challenges issued
 * by the paid endpoints are tracked here until they are paid.
 */
export class ServerState {
  economy: Cred402Economy;
  marketplace: Marketplace;
  readonly economics = new ProtocolEconomics();
  readonly pendingChallenges = new Map<string, PaymentChallenge>();
  // Persistent bus/clock so live SSE subscribers survive a ledger reset.
  private readonly bus = new EventBus();
  private readonly clock = new Clock();

  /** Durable append-only event journal (enabled when CRED402_DATA_DIR is set). */
  readonly journal?: LedgerJournal;

  constructor() {
    this.economy = new Cred402Economy(new Ledger(this.bus, this.clock));
    this.economy.bootstrap();
    this.economy.createJob();
    this.marketplace = new Marketplace(this.ledger);
    this.seedMarketplace();
    const dataDir = loadConfig().dataDir;
    if (dataDir) this.journal = new LedgerJournal(dataDir, this.bus);
  }

  /** List the seller's services across a few pricing strategies (p4 §18). */
  private seedMarketplace(): void {
    const seller = this.economy.seller.agent_id;
    if (this.marketplace.enriched().length > 0) return;
    try {
      this.marketplace.list({ agent_id: seller, category: "rwa.energy_output", strategy: "fixed", base_price: cspr("0.002") });
      this.marketplace.list({ agent_id: seller, category: "rwa.weather_risk", strategy: "dynamic", base_price: cspr("0.002") });
      this.marketplace.list({ agent_id: seller, category: "rwa.payment_monitoring", strategy: "reputation_tiered", base_price: cspr("0.0015") });
    } catch {
      /* agent not registered yet — seeded lazily on first view */
    }
  }

  /** Enriched marketplace listings for the console (p4 §18), seeding if empty. */
  marketplaceView() {
    this.seedMarketplace();
    return this.marketplace.enriched().map((l) => ({
      ...l,
      base_price: l.base_price.toString(),
      min_payment: l.min_payment.toString(),
      stake: l.stake.toString(),
      margin_bps: Number(l.margin_bps),
    }));
  }

  /** Pool health + fee schedule for the console economics view (p4 §11). */
  economicsView() {
    const pool = this.ledger.pool.poolState();
    const slashes = this.ledger.slashing.list();
    const defaultLosses = slashes.reduce((s, r) => s + BigInt(r.amount ?? 0n), 0n);
    const health = this.economics.poolHealth({
      total_liquidity: BigInt(pool.total_liquidity),
      outstanding_credit: BigInt(pool.outstanding_credit),
      interest_accrued: BigInt(pool.interest_accrued),
      fees_collected: 0n, // origination/late fees not tracked separately in the pool state
      default_losses: defaultLosses,
      elapsed_seconds: Math.max(1, this.ledger.clock.now()),
    });
    return {
      fees: {
        facilitator_fee_bps: Number(this.economics.fees.facilitator_fee_bps),
        origination_fee_bps: Number(this.economics.fees.origination_fee_bps),
        interest_spread_bps: Number(this.economics.fees.interest_spread_bps),
        late_fee_bps: Number(this.economics.fees.late_fee_bps),
      },
      health: {
        utilization: health.utilization,
        realized_apy: health.realized_apy,
        realized_yield: health.realized_yield.toString(),
        loss_rate: health.loss_rate,
        risk_flags: health.risk_flags,
      },
    };
  }

  /** Read-only credit explanation with structured reason codes (p5 §15). */
  creditExplain(agentId: string) {
    return this.economy.credit.explain(agentId);
  }

  /** Compliance screening (p2 §7.9) for an agent, plus the data-retention policy. */
  complianceScreen(agentId: string) {
    const svc = new ComplianceService(this.ledger);
    return { screen: svc.screenAgent(agentId), retention: svc.retention.all() };
  }

  get ledger(): Ledger {
    return this.economy.ledger;
  }

  /** Fraud reports for every agent (p2 §7.8). */
  fraudReports() {
    const svc = new FraudService(this.ledger);
    return this.ledger.agents.list().map((a) => svc.analyze(a.agent_id));
  }

  /** RealFi Bridge bound to the current ledger (p6). */
  get realfi(): RealFiBridge {
    return new RealFiBridge(this.ledger);
  }

  /** Snapshot of the RealFi layer for the console. */
  realfiState() {
    return {
      fiatReceipts: this.ledger.fiatReceipts.list(),
      operatorVerifications: this.ledger.operators.list(),
      attestations: this.ledger.realfi.list(),
    };
  }

  /**
   * Run the p6 RealFi flow on the current ledger: verify the seller's operator via
   * Stripe Identity, record settled fiat billing + Plaid cashflow, and re-underwrite
   * to show the bounded credit uplift — populating the RealFi dashboard tab.
   */
  runRealFi(): StepLog[] {
    const econ = this.economy;
    const ledger = this.ledger;
    const seller = econ.seller.agent_id;
    const operatorId = "operator:0xA17solarspv";
    ledger.passports.set_profile(seller, { operator: operatorId });
    const bridge = this.realfi;
    const scenes: StepLog[] = [];

    const before = econ.credit.underwrite(seller).line.max_credit;

    bridge.verifyOperator({
      operator_id: operatorId,
      verification_level: "business_verified",
      jurisdiction: "TR",
      verification_reference: "stripe_idv_ref_" + ledger.operators.list().length,
    });
    for (let i = 0; i < 4; i++) {
      bridge.recordFiatReceipt({
        provider_event_id: `evt_${ledger.fiatReceipts.list().length}_${i}`,
        provider_receipt_id: `ch_${ledger.fiatReceipts.list().length}_${i}`,
        payer_type: "enterprise_customer",
        seller_agent: seller,
        operator_id: operatorId,
        amount: "100.00",
        currency: "USD",
        service_type: "rwa.weather_risk",
        request_hash: "0xreq",
        result_hash: "0xres",
      });
    }
    bridge.recordBankVerification({
      operator_id: operatorId,
      account_ownership_verified: true,
      cashflow_report: { monthly_inflow_usd: 9800, months: 12 },
      balance_snapshot: { usd: 24000 },
      data_period_start: ledger.clock.now() - 31_536_000,
      data_period_end: ledger.clock.now(),
    });

    const after = econ.credit.underwrite(seller);
    scenes.push({
      scene: "RealFi Bridge — verify operator + fiat billing + bank data (no PII)",
      lines: [
        `operator ${operatorId} verified: ${ledger.operators.is_verified(operatorId)}`,
        `on-chain fiat receipts: ${ledger.fiatReceipts.forSeller(seller).length} (hashes only)`,
        `credit line ${formatCspr(before)} → ${formatCspr(after.line.max_credit)} CSPR`,
        `realfi reason codes: ${(after.decision.reason_codes ?? []).filter((c) => ["VERIFIED_OPERATOR", "FIAT_REVENUE", "BANK_CASHFLOW_VERIFIED"].includes(c.code)).map((c) => c.code).join(", ")}`,
      ],
    });
    return scenes;
  }

  /** Run the full honest loop (idempotent-ish: resets first for a clean demo). */
  async runDemo(opts: { dispute?: boolean } = {}): Promise<StepLog[]> {
    this.reset();
    const econ = this.economy;
    const scenes: StepLog[] = [];
    scenes.push(econ.bootstrap());
    scenes.push(econ.createJob());
    const { log, reports } = await econ.runEvidencePurchases({ tamperEnergy: opts.dispute });
    scenes.push(log);
    const audit = await econ.runWatchdogAudit(reports);
    scenes.push(audit.log);
    if (audit.disputed) return scenes;
    scenes.push(econ.applyReputationEngine());
    scenes.push(econ.scoreJob());
    scenes.push(econ.underwriteSeller().log);
    scenes.push(econ.drawCredit(6));
    scenes.push(econ.repay(2));
    scenes.push(econ.routeLiquidity());
    return scenes;
  }

  /**
   * Run the p3 omnichain flow on the current ledger: bind an EVM address, earn on
   * Base, anchor the receipt to Casper, issue a CAN, lend on the satellite vault,
   * and repay — populating the Multichain dashboard tab with real data.
   */
  async runMultichain(): Promise<StepLog[]> {
    const econ = this.economy;
    const ledger = this.ledger;
    const agentId = econ.seller.agent_id;
    const BASE = "eip155:8453";
    const POOL = "0xbasepoolcred402vault000000000000000000a1";

    const casper = new CasperAdapter(ledger);
    const vault = new EvmSatelliteVault(BASE, POOL, ledger.policyPublicKeyHex, 1_000_000_000n);
    const evm = new EvmAdapter(BASE, vault, () => ledger.clock.now());
    const scenes: StepLog[] = [];

    // 1. bind
    const evmKeys = generateEvmKeypair();
    const abe = buildAddressBinding({
      agent_id: agentId,
      casper_account: econ.seller.publicKeyHex,
      casper_private_pem: econ.seller.keys.privatePem,
      external_chain: BASE,
      external_address: evmKeys.address,
      external_private_key: evmKeys.privateKey,
      expires_at: ledger.clock.now() + 31_536_000,
    });
    const bound = await casper.bindAgentAddress(abe);
    await evm.bindAgentAddress(abe);
    scenes.push({ scene: "Bind EVM address to Casper agent", lines: [`bound ${evmKeys.address} → ${agentId} (${bound.ok ? "dual-sig verified" : bound.detail})`] });

    // 2. earn on Base -> anchor to Casper
    const { envelope: ure } = buildUniversalReceipt({
      origin_chain: BASE, settlement_network: "base", payer_agent_id: "rwa-request-agent-base", seller_agent_id: agentId,
      payer_address: "0x1111111111111111111111111111111111111111", seller_address: evmKeys.address,
      asset: "USDC", amount: "40000000", service_type: "rwa.weather_risk",
      request_hash: "0xreq", result_hash: "0xres", payment_proof_hash: "0x" + evmKeys.address.slice(2) + "proof",
      settlement_tx_hash: "0xbasetx", nonce: "0xnonce-" + ledger.externalReceipts.list().length, created_at: ledger.clock.now(),
    });
    await evm.submitReceipt(ure);
    const repBefore = ledger.agents.get(agentId)!.reputation_score;
    const anchored = await casper.submitReceipt(ure);
    const repAfter = ledger.agents.get(agentId)!.reputation_score;
    scenes.push({ scene: "Earn 40 USDC on Base → anchor to Casper", lines: [`anchored ${anchored.tx_hash.slice(0, 18)}…`, `reputation ${repBefore} → ${repAfter}`] });

    // 3. issue CAN (reserve global exposure)
    const agent = ledger.agents.get(agentId)!;
    ledger.exposure.ensure_agent(agentId, 2_000_000_000n);
    const can = ledger.notes.issue_can({
      agent_id: agentId, credit_score: Math.max(agent.credit_score, 80), risk_policy_version: 1,
      target_chain: BASE, target_pool: POOL, max_draw: 500_000_000n, asset: "USDC",
    });
    scenes.push({ scene: "Casper issues a Credit Authorization Note", lines: [`CAN ${can.note_id.slice(0, 18)}… max_draw $${Number(can.max_draw) / 1e6}`] });

    // 4. draw on EVM, confirm on Casper
    const draw = await evm.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
    if (draw.ok) await casper.drawCredit({ note: can, agent_id: agentId, amount: "300000000" });
    scenes.push({ scene: "Borrow $300 on Base under Casper risk control", lines: [`vault lent $300, liquidity $${Number(vault.availableLiquidity()) / 1e6}`] });

    // 5. repay
    await evm.repayCredit({ agent_id: agentId, amount: "300000000" });
    await casper.repayCredit({ agent_id: agentId, amount: "300000000" });
    scenes.push({ scene: "Repay → Casper releases exposure", lines: [`outstanding $${Number(ledger.exposure.get_agent_global_exposure(agentId)!.outstanding) / 1e6}`] });
    return scenes;
  }

  reset(): void {
    this.economy.watchdog.stop(); // detach the old watchdog from the persistent bus
    this.bus.clearLog();
    this.economy = new Cred402Economy(new Ledger(this.bus, this.clock));
    this.marketplace = new Marketplace(this.ledger);
    this.pendingChallenges.clear();
  }
}

let _state: ServerState | null = null;
export function getState(): ServerState {
  if (!_state) _state = new ServerState();
  return _state;
}
