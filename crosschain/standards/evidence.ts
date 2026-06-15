import { stableStringify } from "../../lib/core/hash.js";
import { sign as edSign, verifyCasperHex } from "../../lib/x402/keys.js";

/**
 * EAE — Evidence Attestation Envelope (p3 §5). A standard, signed shape for every
 * agent-submitted RWA evidence item, rooted to a Casper-signed agent key.
 */
export interface EvidenceAttestationEnvelope {
  type: "Cred402EvidenceAttestation";
  version: "1";
  uaid: string;
  agent_id: string;
  origin_chain: string;
  evidence_type: string;
  evidence_hash: string;
  source_hash: string;
  linked_receipt_id: string;
  confidence_bps: number;
  timestamp: number;
  signature?: string;
}

export function evidenceSigningPayload(eae: EvidenceAttestationEnvelope): string {
  const { signature, ...unsigned } = eae;
  void signature;
  return stableStringify(unsigned);
}

export function buildEvidenceAttestation(
  fields: Omit<EvidenceAttestationEnvelope, "type" | "version" | "signature">,
  agentCasperPrivatePem: string,
): EvidenceAttestationEnvelope {
  const base: EvidenceAttestationEnvelope = { type: "Cred402EvidenceAttestation", version: "1", ...fields };
  return { ...base, signature: edSign(agentCasperPrivatePem, evidenceSigningPayload(base)) };
}

export function verifyEvidenceAttestation(eae: EvidenceAttestationEnvelope, agentCasperPubHex: string): { ok: boolean; reason?: string } {
  if (eae.type !== "Cred402EvidenceAttestation") return { ok: false, reason: "wrong type" };
  if (!eae.signature) return { ok: false, reason: "missing signature" };
  if (eae.confidence_bps < 0 || eae.confidence_bps > 10000) return { ok: false, reason: "confidence out of range" };
  if (!verifyCasperHex(agentCasperPubHex, evidenceSigningPayload(eae), eae.signature)) {
    return { ok: false, reason: "invalid agent signature" };
  }
  return { ok: true };
}
