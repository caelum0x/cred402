import type { CasperAdapter } from "../../packages/chain-adapters/src/adapters/casper/CasperAdapter.js";
import type { ChainEvent } from "../../packages/chain-adapters/src/core/ChainAdapter.js";
import type { UniversalReceiptEnvelope } from "../standards/receipts.js";
import { ProofService, type ChainEventProof, type ChainEventRecord } from "../proof-service/proof_service.js";

/**
 * CasperRootRelayer (p3 crosschain/relayers/casper-root-relayer).
 *
 * Observes a satellite chain's event log, commits each new batch to the
 * {@link ProofService} (one signed Merkle root + per-event inclusion proofs),
 * then anchors the facts to the Casper root — but ONLY after the Casper side
 * re-verifies the proof against its trusted-relayer allowlist. This is the
 * "Casper-rooted, chain-executed" path made real:
 *
 *   ReceiptCreated → anchor the Universal Receipt on Casper (reputation settles)
 *   CreditDrawn    → activate reserved global exposure on Casper
 *   CreditRepaid   → release global exposure on Casper
 *
 * A checkpoint guarantees at-most-once anchoring across repeated syncs.
 */

export interface SatelliteSource {
  chainId(): string;
  recentEvents(): ChainEvent[];
}

export interface RelaySyncResult {
  batchRoot: string | null;
  proofs: ChainEventProof[];
  anchored: number;
  drawsReconciled: number;
  repaymentsReconciled: number;
  rejected: number;
  skipped: number;
}

export class CasperRootRelayer {
  private checkpoint = 0;
  readonly relayerKey: string;
  /** Casper's allowlist of relayer keys whose proofs it will accept. */
  private readonly trustedRelayers: Set<string>;

  constructor(
    private readonly satellite: SatelliteSource,
    private readonly casper: CasperAdapter,
    private readonly proofService: ProofService = new ProofService(),
  ) {
    this.relayerKey = proofService.relayerKey;
    this.trustedRelayers = new Set([this.relayerKey]);
  }

  /** Process every satellite event observed since the last checkpoint. */
  async sync(): Promise<RelaySyncResult> {
    const all = this.satellite.recentEvents();
    const fresh = all.slice(this.checkpoint);
    const result: RelaySyncResult = {
      batchRoot: null,
      proofs: [],
      anchored: 0,
      drawsReconciled: 0,
      repaymentsReconciled: 0,
      rejected: 0,
      skipped: 0,
    };
    if (fresh.length === 0) return result;

    // Build finality-ordered records (observed_at = global sequence height).
    const records: ChainEventRecord[] = fresh.map((e, i) => ({
      origin_chain: e.chain,
      event_type: e.type,
      observed_at: this.checkpoint + i,
      payload: e.data,
    }));
    const batch = this.proofService.commitBatch(records);
    result.batchRoot = batch.root;
    result.proofs = batch.proofs;

    for (const proof of batch.proofs) {
      // Casper re-verifies the relayed proof before trusting any anchor.
      const verdict = ProofService.verify(proof, this.trustedRelayers);
      if (!verdict.ok) {
        result.rejected++;
        continue;
      }
      await this.route(proof, result);
    }

    this.checkpoint = all.length;
    return result;
  }

  private async route(proof: ChainEventProof, result: RelaySyncResult): Promise<void> {
    switch (proof.event_type) {
      case "ReceiptCreated": {
        const ure = proof.payload.envelope as UniversalReceiptEnvelope | undefined;
        if (!ure) {
          result.rejected++;
          return;
        }
        const tx = await this.casper.submitReceipt(ure);
        if (tx.ok) result.anchored++;
        else result.rejected++;
        return;
      }
      case "CreditDrawn": {
        const noteId = String(proof.payload.note_id ?? "");
        const amount = BigInt(String(proof.payload.amount ?? "0"));
        const tx = this.casper.confirmSatelliteDraw(noteId, amount);
        if (tx.ok) result.drawsReconciled++;
        else result.rejected++;
        return;
      }
      case "CreditRepaid": {
        const agentId = String(proof.payload.agent_id ?? "");
        const amount = String(proof.payload.amount ?? "0");
        const tx = await this.casper.repayCredit({ agent_id: agentId, amount });
        if (tx.ok) result.repaymentsReconciled++;
        else result.rejected++;
        return;
      }
      default:
        // AddressBindingMirrored / EvidenceMirrored are identity/evidence mirrors
        // already rooted on Casper directly; nothing to anchor from the satellite.
        result.skipped++;
    }
  }
}
