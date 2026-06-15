import { BaseAgent } from "./base_agent.js";
import type { EvidenceSellerAgent, EvidenceReport } from "./evidence_seller_agent.js";
import type { Ledger } from "../lib/ledger/index.js";
import type { Receipt, RwaJob } from "../lib/core/types.js";
import { cspr } from "../lib/core/units.js";
import { signPayment, challengeHeaders } from "../lib/x402/index.js";
import { SOLAR_A17 } from "../api/rwa_data/index.js";

export interface PurchaseResult {
  evidence_type: string;
  report: EvidenceReport;
  receipt: Receipt;
  challenge_headers: Record<string, string>;
}

/**
 * BuyerAgent (RWARequestAgent) — represents the RWA protocol that needs evidence
 * before lenders fund the asset. It registers the RWA job, then autonomously buys
 * each required piece of evidence from seller agents over x402: receives the 402,
 * signs a payment authorization with its own ed25519 key, and collects the report.
 */
export class BuyerAgent extends BaseAgent {
  constructor(ledger: Ledger, agent_id = "RWARequestAgent") {
    super(ledger, { agent_id, service_type: "risk_scoring" });
  }

  /** Register the demo solar-farm verification job. */
  createSolarJob(args?: { requested_loan_cspr?: number; bounty_cspr?: number }): RwaJob {
    return this.ledger.jobs.create_job({
      rwa_id: SOLAR_A17.rwa_id,
      name: SOLAR_A17.name,
      location: SOLAR_A17.location,
      monthly_output_kwh: SOLAR_A17.monthly_output_kwh,
      expected_receivable_usd: SOLAR_A17.expected_receivable_usd,
      requested_loan: cspr(args?.requested_loan_cspr ?? 5000),
      collateral_type: SOLAR_A17.collateral_type,
      needed_evidence: [...SOLAR_A17.needed_evidence],
      bounty_per_evidence: cspr(args?.bounty_cspr ?? 0.002),
    });
  }

  /**
   * The full x402 purchase for one evidence type against a seller agent.
   * Returns the report plus the recorded on-chain receipt.
   */
  async buyEvidence(
    seller: EvidenceSellerAgent,
    rwa_id: string,
    evidence_type: string,
    amount_motes: bigint,
    opts: { tampered?: boolean } = {},
  ): Promise<PurchaseResult> {
    // 1. Seller responds 402 Payment Required.
    const challenge = seller.quote({ rwa_id, evidence_type, amount_motes });

    // 2. Buyer signs a domain-separated payment authorization (casper-eip-712 style).
    const { proof } = signPayment({
      challenge,
      payer_agent: this.agent_id,
      payer_public_key: this.publicKeyHex,
      payer_private_pem: this.keys.privatePem,
    });

    // 3. Seller verifies the proof and delivers the signed report.
    const { report, receipt, evidence } = await seller.fulfill({
      rwa_id,
      evidence_type,
      challenge,
      proof,
      payer_agent: this.agent_id,
      tampered: opts.tampered,
    });

    // 4. Buyer confirms delivery -> settle, verify evidence, reward reputation.
    this.ledger.receipts.settle_receipt(receipt.receipt_id);
    if (!opts.tampered) {
      this.ledger.evidence.verify_evidence(evidence.evidence_id);
      this.ledger.receipts.finalize_receipt(receipt.receipt_id);
      this.ledger.agents.update_reputation(seller.agent_id, +2, report.evidence_hash, "FINALIZED_VERIFIED_SERVICE");
    }

    return {
      evidence_type,
      report,
      receipt,
      challenge_headers: challengeHeaders(challenge),
    };
  }
}
