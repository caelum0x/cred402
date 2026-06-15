import { BaseAgent } from "./base_agent.js";
import type { Ledger } from "../lib/ledger/index.js";
import type { Evidence, Receipt, ServiceType } from "../lib/core/types.js";
import { hashObject, shortId } from "../lib/core/hash.js";
import {
  type PaymentChallenge,
  type PaymentProof,
  verifyPayment,
  paymentProofHash,
} from "../lib/x402/index.js";
import { fetchEvidence, isKnownEvidenceType, serviceTypeFor } from "../api/rwa_data/index.js";

export interface EvidenceReport {
  rwa_id: string;
  evidence_type: string;
  service_type: ServiceType;
  fields: Record<string, unknown>;
  confidence: number;
  evidence_hash: string;
  result_hash: string;
  seller_agent: string;
  signed_by: string;
}

/**
 * EvidenceSellerAgent — runs paid evidence endpoints. It quotes a price, demands
 * x402 payment, verifies the payment proof, generates a signed verification
 * report from the real RWA data layer (Open-Meteo solar + PV physics, see
 * `api/rwa_data`), and records both the receipt and the evidence hash on Casper.
 *
 *   GET /verify/solar-output?rwa_id=SOLAR-A17   ->   402 Payment Required
 */
export class EvidenceSellerAgent extends BaseAgent {
  constructor(ledger: Ledger, agent_id = "EvidenceSellerAgent") {
    super(ledger, { agent_id, service_type: "solar_output_verification" });
  }

  /** Step 1 — return a 402 PaymentChallenge for an evidence request. */
  quote(args: {
    rwa_id: string;
    evidence_type: string;
    amount_motes: bigint;
  }): PaymentChallenge {
    if (!isKnownEvidenceType(args.evidence_type)) {
      throw new Error(`unknown evidence type: ${args.evidence_type}`);
    }
    return {
      payment_id: shortId("pay"),
      amount_motes: args.amount_motes.toString(),
      network: "casper",
      asset: "CSPR",
      resource: `/verify/${args.evidence_type}?rwa_id=${args.rwa_id}`,
      service_type: serviceTypeFor(args.evidence_type),
      seller_agent: this.agent_id,
      nonce: shortId("nonce"),
      expires_at: this.ledger.clock.now() + 300,
    };
  }

  /**
   * Step 2 — verify payment, deliver the report, and commit receipt + evidence
   * hashes on-chain. `tampered` drives the dispute/slashing demo.
   */
  async fulfill(args: {
    rwa_id: string;
    evidence_type: string;
    challenge: PaymentChallenge;
    proof: PaymentProof;
    payer_agent: string;
    tampered?: boolean;
  }): Promise<{ report: EvidenceReport; receipt: Receipt; evidence: Evidence }> {
    const check = verifyPayment({ challenge: args.challenge, proof: args.proof, now: this.ledger.clock.now() });
    if (!check.ok) throw new Error(`x402 payment rejected: ${check.reason}`);

    const payload = await fetchEvidence(args.evidence_type, { tampered: args.tampered });
    const rwa_reference_hash = hashObject({ rwa_id: args.rwa_id });
    const result_hash = hashObject(payload.fields);
    const evidence_hash = hashObject({ ...payload.fields, rwa_id: args.rwa_id });
    const request_hash = hashObject({ resource: args.challenge.resource, payment_id: args.challenge.payment_id });

    const report: EvidenceReport = {
      rwa_id: args.rwa_id,
      evidence_type: args.evidence_type,
      service_type: payload.service_type,
      fields: payload.fields,
      confidence: payload.confidence,
      evidence_hash,
      result_hash,
      seller_agent: this.agent_id,
      signed_by: this.publicKeyHex,
    };

    // Record the x402 receipt commitment.
    const receipt = this.ledger.receipts.record_receipt({
      payer_agent: args.payer_agent,
      seller_agent: this.agent_id,
      service_type: payload.service_type,
      amount: BigInt(args.challenge.amount_motes),
      rwa_reference_hash,
      result_hash,
      payment_proof_hash: paymentProofHash(args.proof),
      request_hash,
      nonce: args.challenge.nonce,
      expires_at: args.challenge.expires_at,
    });

    // Submit the evidence hash, linked to the receipt.
    const evidence = this.ledger.evidence.submit_evidence({
      rwa_id: args.rwa_id,
      agent_id: this.agent_id,
      evidence_type: args.evidence_type,
      evidence_hash,
      confidence: payload.confidence,
      linked_receipt_id: receipt.receipt_id,
    });

    // Realize revenue + job completion in the registry (accuracy reflects honesty).
    this.ledger.agents.record_job(
      this.agent_id,
      {
        receipt_id: receipt.receipt_id,
        amount: BigInt(args.challenge.amount_motes),
        timestamp: this.ledger.clock.now(),
        service_type: payload.service_type,
      },
      args.tampered ? 35 : payload.confidence,
      false,
    );

    return { report, receipt, evidence };
  }
}
