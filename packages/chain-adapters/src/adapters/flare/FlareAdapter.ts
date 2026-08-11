import type {
  ChainAdapter,
  ChainCapabilities,
  ChainEvent,
  ChainEventFilter,
  CreditDrawRequest,
  CreditRepaymentRequest,
  TransactionResult,
} from "../../core/ChainAdapter.js";
import type { AddressBindingEnvelope } from "../../../../../crosschain/standards/bindings.js";
import { verifyAddressBinding } from "../../../../../crosschain/standards/bindings.js";
import type { UniversalReceiptEnvelope } from "../../../../../crosschain/standards/receipts.js";
import { makeReceiptId } from "../../../../../crosschain/standards/receipts.js";
import type { EvidenceAttestationEnvelope } from "../../../../../crosschain/standards/evidence.js";
import type { CreditAuthorizationNote } from "../../../../../crosschain/standards/credit_notes.js";
import { keccak256 } from "../../../../../lib/x402/evm.js";
import type { OnchainExecutor } from "../../../../../lib/keeperhub/types.js";
import { FlareSatelliteVault } from "./FlareSatelliteVault.js";
import { FdcClient } from "./fdc.js";
import { resolveFlareNetwork, type FlareNetwork } from "./networks.js";
import { FXRP } from "./fassets.js";

/**
 * FlareAdapter — a Flare satellite (Coston2 / Songbird / Flare mainnet). It settles
 * x402 receipts, attests cross-chain payments through the FDC, and executes credit
 * in the interoperable FAsset FXRP through a {@link FlareSatelliteVault}, gated by a
 * Casper-issued Credit Authorization Note and priced by FTSO.
 *
 * "The last mile": when a KeeperHub {@link OnchainExecutor} is injected, the adapter
 * DECIDES the credit action and hands the actual on-chain submission to KeeperHub —
 * preflight simulation, smart gas w/ backoff, MEV-protected routing, audit trail,
 * paid per-execution over x402/MPP — so the transaction lands instead of stalling.
 */
export class FlareAdapter implements ChainAdapter {
  private readonly events: ChainEvent[] = [];
  readonly network: FlareNetwork;
  readonly fdc: FdcClient;

  constructor(
    private readonly chainIdStr: string,
    readonly vault: FlareSatelliteVault,
    private readonly opts: {
      executor?: OnchainExecutor;
      fdc?: FdcClient;
      clock?: () => number;
    } = {},
  ) {
    this.network = resolveFlareNetwork(chainIdStr);
    this.fdc = opts.fdc ?? new FdcClient();
  }

  private clock(): number {
    return this.opts.clock ? this.opts.clock() : Math.floor(Date.now() / 1000);
  }

  chainId(): string {
    return this.chainIdStr;
  }
  family(): "flare" {
    return "flare";
  }
  async getCapabilities(): Promise<ChainCapabilities> {
    return { smartContracts: true, x402Settlement: true, creditExecution: true, finalitySeconds: 2 };
  }

  async bindAgentAddress(input: AddressBindingEnvelope): Promise<TransactionResult> {
    const check = verifyAddressBinding(input, this.clock());
    if (!check.ok) return { ok: false, tx_hash: "", detail: check.reason };
    const tx_hash = keccak256(`flarebind:${input.external_address}:${input.agent_id}`);
    this.emit("AddressBindingMirrored", { agent_id: input.agent_id, address: input.external_address });
    return { ok: true, tx_hash };
  }

  /**
   * x402 receipt settlement. The receipt's underlying payment is attested by the FDC
   * (proving off-Flare value really moved) before the Casper-root relayer anchors it,
   * so reputation on Casper is backed by a Flare-verified fact.
   */
  async submitReceipt(input: UniversalReceiptEnvelope): Promise<TransactionResult> {
    const tx_hash = makeReceiptId(input);
    const attestation = await this.fdc.attestPayment({
      attestationType: "Payment",
      sourceId: input.settlement_network ?? "XRP",
      transactionId: input.settlement_tx_hash ?? tx_hash,
    });
    this.emit("ReceiptCreated", {
      receipt_id: tx_hash,
      seller: input.seller_agent_id,
      amount: input.amount,
      fdc_attestation_id: attestation.attestation_id,
      fdc_verified: attestation.verified,
      fdc_source: attestation.source,
      envelope: input,
    });
    return { ok: true, tx_hash, detail: `fdc:${attestation.source}:${attestation.verified ? "verified" : "unverified"}` };
  }

  async submitEvidence(input: EvidenceAttestationEnvelope): Promise<TransactionResult> {
    const tx_hash = keccak256(`flareevidence:${input.evidence_hash}:${input.agent_id}`);
    this.emit("EvidenceMirrored", { uaid: input.uaid, agent_id: input.agent_id });
    return { ok: true, tx_hash };
  }

  async verifyCreditAuthorization(note: CreditAuthorizationNote): Promise<boolean> {
    return this.vault.verifyNote(note, this.clock()).ok;
  }

  /**
   * Draw FXRP against a CAN. The vault validates + prices the draw (FTSO); KeeperHub
   * executes the on-chain transaction with full reliability guarantees when injected.
   */
  async drawCredit(input: CreditDrawRequest): Promise<TransactionResult> {
    try {
      const draw = await this.vault.draw(input.note, BigInt(input.amount), this.clock());
      let tx_hash = draw.tx_hash;
      let executionDetail: Record<string, unknown> = {};

      if (this.opts.executor) {
        const exec = await this.opts.executor.execute({
          kind: "credit_draw",
          chain_id: this.network.keeperhubChainId,
          to: this.vault.poolAddress,
          function: "executeDraw(bytes32,address,uint256)",
          args: [draw.note_id, draw.agent_id, input.amount],
          agent_id: draw.agent_id,
          label: `cred402 FXRP draw ${draw.agent_id}`,
          metadata: {
            note_id: draw.note_id,
            usd_6dp: draw.usd_6dp.toString(),
            xrp_usd: draw.xrp_usd,
            price_source: draw.price_source,
          },
        });
        if (!exec.ok) {
          // On-chain execution failed — undo the vault commit so the JS mirror does
          // not claim a draw that never landed (and the CAN note is not burned).
          this.vault.rollbackDraw(draw);
          return { ok: false, tx_hash: "", detail: `keeperhub: ${exec.detail ?? "execution failed"}` };
        }
        tx_hash = exec.tx_hash;
        executionDetail = {
          keeperhub_execution_id: exec.execution_id,
          keeperhub_audit_id: exec.audit_id,
          payment_protocol: exec.payment.protocol,
          private_routed: exec.private_routed,
          sponsored: exec.sponsored,
          gas_backoff_attempts: exec.gas.attempts,
          execution_source: exec.source,
        };
      }

      this.emit("CreditDrawn", {
        agent_id: draw.agent_id,
        // `amount` is the USD-micro value the Casper root reconciles against the
        // global exposure cap (single USD denominator). FXRP token amount is separate.
        amount: draw.usd_6dp.toString(),
        amount_fxrp: draw.amount.toString(),
        asset: FXRP.symbol,
        usd_6dp: draw.usd_6dp.toString(),
        xrp_usd: draw.xrp_usd,
        price_source: draw.price_source,
        note_id: draw.note_id,
        ...executionDetail,
      });
      return { ok: true, tx_hash, detail: draw.price_source === "ftso" ? "ftso-priced" : "sim-priced" };
    } catch (err) {
      return { ok: false, tx_hash: "", detail: (err as Error).message };
    }
  }

  async repayCredit(input: CreditRepaymentRequest): Promise<TransactionResult> {
    const { tx_hash, remaining, paid, usd_6dp } = await this.vault.repay(input.agent_id, BigInt(input.amount), this.clock());
    let finalTx = tx_hash;
    let executionDetail: Record<string, unknown> = {};
    if (this.opts.executor) {
      const exec = await this.opts.executor.execute({
        kind: "credit_repay",
        chain_id: this.network.keeperhubChainId,
        to: this.vault.poolAddress,
        function: "executeRepay(address,uint256)",
        args: [input.agent_id, input.amount],
        agent_id: input.agent_id,
        label: `cred402 FXRP repay ${input.agent_id}`,
        metadata: { remaining: remaining.toString(), usd_6dp: usd_6dp.toString() },
      });
      if (!exec.ok) {
        // On-chain repay failed — undo the vault credit so we do not report a
        // repayment that never settled (symmetric with drawCredit).
        this.vault.rollbackRepay(input.agent_id, paid);
        return { ok: false, tx_hash: "", detail: `keeperhub: ${exec.detail ?? "repay failed"}` };
      }
      finalTx = exec.tx_hash;
      executionDetail = { keeperhub_execution_id: exec.execution_id, keeperhub_audit_id: exec.audit_id };
    }
    // `amount` carries the USD-micro value the Casper root releases against global
    // exposure; the FXRP token amount is reported separately.
    this.emit("CreditRepaid", {
      agent_id: input.agent_id,
      amount: usd_6dp.toString(),
      amount_fxrp: input.amount,
      remaining: remaining.toString(),
      ...executionDetail,
    });
    return { ok: true, tx_hash: finalTx };
  }

  async *watchEvents(filter: ChainEventFilter): AsyncIterable<ChainEvent> {
    for (const e of this.events) {
      if (!filter.type || e.type === filter.type) yield e;
    }
  }

  recentEvents(): ChainEvent[] {
    return [...this.events];
  }

  private emit(type: string, data: Record<string, unknown>): void {
    this.events.push({ chain: this.chainIdStr, type, data });
  }
}
