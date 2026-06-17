import { EventBus } from "./events.js";
import { Clock } from "./clock.js";
import { AgentRegistry } from "./contracts/agent_registry.js";
import { X402ReceiptRegistry } from "./contracts/x402_receipt_registry.js";
import { RWAEvidenceRegistry } from "./contracts/rwa_evidence_registry.js";
import { AgentCreditPool } from "./contracts/agent_credit_pool.js";
import { RiskPolicyManager } from "./contracts/risk_policy_manager.js";
import { ServiceCategoryRegistry } from "./contracts/service_category_registry.js";
import { RWAJobBoard } from "./contracts/rwa_jobs.js";
import { DisputeCourt } from "./contracts/dispute_court.js";
import { SlashingVault } from "./contracts/slashing_vault.js";
import { Governance } from "./contracts/governance.js";
import { ReputationEngine } from "./contracts/reputation_engine.js";
import { RWAAssetRegistry } from "./contracts/rwa_asset_registry.js";
import { AgentPassportRegistry } from "./contracts/agent_passport.js";
import { AddressBindingRegistry } from "./contracts/address_binding_registry.js";
import { ExternalReceiptRegistry } from "./contracts/external_receipt_registry.js";
import { GlobalExposureManager } from "./contracts/global_exposure_manager.js";
import { CreditAuthorizationNotes } from "./contracts/credit_authorization_notes.js";
import { UpgradeManager } from "./contracts/upgrade_manager.js";
import { FiatReceiptRegistry } from "./contracts/fiat_receipt_registry.js";
import { OperatorVerificationRegistry } from "./contracts/operator_verification_registry.js";
import { RealFiAttestationRegistry } from "./contracts/realfi_attestation_registry.js";
import type { AgentPassport } from "../core/protocol_types.js";
import type { UniversalReceiptEnvelope } from "../../crosschain/standards/receipts.js";
import { makeReceiptId } from "../../crosschain/standards/receipts.js";
import { generateAgentKeypair, type AgentKeypair } from "../x402/keys.js";
import { deployHash } from "../core/hash.js";

/** Normalized cross-chain FX: 1 CSPR = $0.04 → 1 USD micro-unit = 25_000 motes. */
export const USD_MICRO_TO_MOTES = 25_000n;

/**
 * Ledger — a faithful in-memory simulation of the Cred402 contract suite deployed
 * to Casper. Each property is one deployed contract with its own package hash.
 * The agent runtime and API talk to this exactly as they would to on-chain
 * contracts via casper-js-sdk; swapping this for live Testnet calls is a drop-in.
 */
export class Ledger {
  readonly bus: EventBus;
  readonly clock: Clock;

  readonly agents: AgentRegistry;
  readonly receipts: X402ReceiptRegistry;
  readonly evidence: RWAEvidenceRegistry;
  readonly pool: AgentCreditPool;
  readonly policy: RiskPolicyManager;
  readonly serviceCategories: ServiceCategoryRegistry;
  readonly jobs: RWAJobBoard;

  /**
   * A bus/clock can be injected so they survive a ledger reset — keeping live SSE
   * subscribers (e.g. the dashboard) attached across a `Reset demo` action.
   */
  constructor(bus?: EventBus, clock?: Clock) {
    this.bus = bus ?? new EventBus();
    this.clock = clock ?? new Clock();
    this.agents = new AgentRegistry(this.bus, this.clock);
    this.receipts = new X402ReceiptRegistry(this.bus, this.clock);
    this.evidence = new RWAEvidenceRegistry(this.bus, this.clock);
    this.pool = new AgentCreditPool(this.bus, this.clock);
    this.policy = new RiskPolicyManager(this.bus, this.clock);
    this.serviceCategories = new ServiceCategoryRegistry(this.bus, this.clock);
    this.jobs = new RWAJobBoard(this.bus, this.clock);
    this.disputes = new DisputeCourt(this.bus, this.clock);
    this.slashing = new SlashingVault(this.bus, this.clock);
    this.governance = new Governance(this.bus, this.clock);
    this.assets = new RWAAssetRegistry(this.bus, this.clock);
    this.reputation = new ReputationEngine();
    this.passports = new AgentPassportRegistry();
    // p3 omnichain layer
    this.bindings = new AddressBindingRegistry(this.bus, this.clock);
    this.externalReceipts = new ExternalReceiptRegistry(this.bus, this.clock);
    this.exposure = new GlobalExposureManager(this.bus, this.clock);
    this.policyKeys = generateAgentKeypair();
    this.notes = new CreditAuthorizationNotes(this.bus, this.clock, this.policyKeys.privatePem, this.exposure);
    this.upgrades = new UpgradeManager(this.bus, this.clock);
    // p6 RealFi Bridge layer
    this.fiatReceipts = new FiatReceiptRegistry(this.bus, this.clock);
    this.operators = new OperatorVerificationRegistry(this.bus, this.clock);
    this.realfi = new RealFiAttestationRegistry(this.bus, this.clock);
    for (const [name, hash] of Object.entries(this.contractHashes)) {
      this.upgrades.register_contract(name, hash, deployHash());
    }
  }

  readonly disputes: DisputeCourt;
  readonly slashing: SlashingVault;
  readonly governance: Governance;
  readonly assets: RWAAssetRegistry;
  readonly reputation: ReputationEngine;
  readonly passports: AgentPassportRegistry;
  readonly bindings: AddressBindingRegistry;
  readonly externalReceipts: ExternalReceiptRegistry;
  readonly exposure: GlobalExposureManager;
  readonly notes: CreditAuthorizationNotes;
  readonly upgrades: UpgradeManager;
  readonly policyKeys: AgentKeypair;
  // p6 RealFi Bridge
  readonly fiatReceipts: FiatReceiptRegistry;
  readonly operators: OperatorVerificationRegistry;
  readonly realfi: RealFiAttestationRegistry;

  /** Casper-rooted policy public key that signs Credit Authorization Notes. */
  get policyPublicKeyHex(): string {
    return this.policyKeys.publicKeyHex;
  }

  /**
   * Anchor an external (non-Casper) x402 receipt to Casper and credit the seller
   * agent: the work happened on a satellite chain, the trust settles here.
   */
  anchorExternalReceipt(ure: UniversalReceiptEnvelope): { receipt_id: string } {
    const receipt_id = makeReceiptId(ure);
    this.externalReceipts.record_external_receipt(ure, receipt_id);
    this.externalReceipts.finalize_external_receipt(receipt_id);
    // Credit the seller agent's revenue + reputation if it is a known Casper agent.
    if (this.agents.get(ure.seller_agent_id)) {
      // amount is in asset smallest units; treat USD-pegged stables as USD micro.
      const motes = (BigInt(ure.amount) * USD_MICRO_TO_MOTES);
      this.agents.record_job(
        ure.seller_agent_id,
        { receipt_id, amount: motes, timestamp: this.clock.now(), service_type: "monitoring" },
        90,
        false,
      );
      this.agents.update_reputation(ure.seller_agent_id, +1, receipt_id);
    }
    return { receipt_id };
  }

  /** Simulated deployed contract package hashes (stable per process). */
  readonly contractHashes = {
    AgentRegistry: `hash-${deployHash().slice(0, 40)}`,
    AgentPassport: `hash-${deployHash().slice(0, 40)}`,
    X402ReceiptRegistry: `hash-${deployHash().slice(0, 40)}`,
    RWAAssetRegistry: `hash-${deployHash().slice(0, 40)}`,
    RWAEvidenceRegistry: `hash-${deployHash().slice(0, 40)}`,
    ReputationEngine: `hash-${deployHash().slice(0, 40)}`,
    AgentCreditPool: `hash-${deployHash().slice(0, 40)}`,
    RiskPolicyManager: `hash-${deployHash().slice(0, 40)}`,
    DisputeCourt: `hash-${deployHash().slice(0, 40)}`,
    SlashingVault: `hash-${deployHash().slice(0, 40)}`,
    Governance: `hash-${deployHash().slice(0, 40)}`,
    AddressBindingRegistry: `hash-${deployHash().slice(0, 40)}`,
    ExternalReceiptRegistry: `hash-${deployHash().slice(0, 40)}`,
    GlobalExposureManager: `hash-${deployHash().slice(0, 40)}`,
    CreditAuthorizationNotes: `hash-${deployHash().slice(0, 40)}`,
    UpgradeManager: `hash-${deployHash().slice(0, 40)}`,
    FiatReceiptRegistry: `hash-${deployHash().slice(0, 40)}`,
    OperatorVerificationRegistry: `hash-${deployHash().slice(0, 40)}`,
    RealFiAttestationRegistry: `hash-${deployHash().slice(0, 40)}`,
  };

  /** Build an agent's read-optimized public passport (p2 §6.2). */
  buildPassport(agent_id: string): AgentPassport | undefined {
    const agent = this.agents.get(agent_id);
    if (!agent) return undefined;
    return this.passports.build({
      agent,
      line: this.pool.get(agent_id),
      receipts: this.receipts.list(),
      open_disputes: this.disputes.openCount(agent_id),
      now: this.clock.now(),
    });
  }

  /** A complete snapshot for the dashboard / API serialization. */
  snapshot() {
    return {
      contractHashes: this.contractHashes,
      policyVersion: this.policy.version(),
      agents: this.agents.list(),
      receipts: this.receipts.list(),
      evidence: this.evidence.list(),
      jobs: this.jobs.list(),
      creditLines: this.pool.list(),
      pool: this.pool.poolState(),
      estimatedApy: this.pool.estimatedApy(),
      assets: this.assets.list(),
      disputes: this.disputes.list(),
      slashes: this.slashing.list(),
      slashReserves: this.slashing.reserveBalances(),
      governance: this.governance.get(),
      governanceHistory: this.governance.parameterHistory(),
      passports: this.agents.list().map((a) => this.buildPassport(a.agent_id)!),
      policyPublicKey: this.policyPublicKeyHex,
      addressBindings: this.bindings.list(),
      externalReceipts: this.externalReceipts.list(),
      globalExposure: this.exposure.list(),
      creditNotes: this.notes.list(),
      contractVersions: this.upgrades.list(),
      fiatReceipts: this.fiatReceipts.list(),
      operatorVerifications: this.operators.list(),
      realfiAttestations: this.realfi.list(),
      events: this.bus.all(),
    };
  }
}

/** Process-wide singleton used by the API server and demo scripts. */
let _ledger: Ledger | null = null;
export function getLedger(): Ledger {
  if (!_ledger) _ledger = new Ledger();
  return _ledger;
}
export function resetLedger(): Ledger {
  _ledger = new Ledger();
  return _ledger;
}
