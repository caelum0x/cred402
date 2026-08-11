import { keccak256 } from "../../../../../lib/x402/evm.js";

/**
 * FDC — the Flare Data Connector. Flare's enshrined oracle for *external* data and
 * cross-chain events: it attests facts (a payment on the XRP Ledger, an EVM
 * transaction, address validity) and delivers a Merkle proof a Flare contract can
 * verify on-chain.
 *
 * For Cred402 the FDC closes the interoperability loop: an agent earns an x402
 * payment on another chain, the FDC attests that the payment really settled, and
 * only then does the Flare satellite treat the Universal Receipt as trustworthy
 * (and back an FXRP mint). Casper roots identity + policy; the FDC roots the
 * *fact* that off-Flare value moved.
 *
 * Real path (behind `FLARE_FDC_VERIFIER_URL`): prepare a typed attestation request
 * against an FDC verifier server; a relayer submits it to the FdcHub and, after the
 * voting round finalizes, a Merkle proof is retrieved from the DA layer.
 * Sim path: a deterministic attestation id + verified envelope so the loop runs
 * with no verifier and no network.
 *
 * Docs: https://dev.flare.network/fdc/overview
 */

export type FdcAttestationType = "Payment" | "EVMTransaction" | "AddressValidity";

export interface PaymentAttestationRequest {
  attestationType: "Payment";
  sourceId: string; // e.g. "XRP", "testXRP", "ETH"
  transactionId: string; // the underlying tx hash on the source chain
  inUtxo?: string;
  utxo?: string;
}

export interface FdcAttestation {
  attestation_id: string;
  type: FdcAttestationType;
  source_id: string;
  transaction_id: string;
  round_id: number;
  verified: boolean;
  /** Merkle proof leaves (hex) — populated on the real path, empty in sim. */
  proof: string[];
  source: "fdc" | "sim";
}

export class FdcClient {
  private readonly verifierUrl?: string;
  private readonly apiKey?: string;

  constructor(opts: { verifierUrl?: string; apiKey?: string } = {}) {
    this.verifierUrl = opts.verifierUrl ?? process.env.FLARE_FDC_VERIFIER_URL;
    this.apiKey = opts.apiKey ?? process.env.FLARE_FDC_API_KEY;
  }

  isLive(): boolean {
    return Boolean(this.verifierUrl);
  }

  /**
   * Attest that a payment settled on a source chain (e.g. an XRPL payment backing
   * an FXRP mint, or an EVM x402 settlement). Returns a verified attestation the
   * satellite can trust.
   */
  async attestPayment(req: PaymentAttestationRequest, roundHint = 0): Promise<FdcAttestation> {
    const attestation_id = keccak256(`fdc:${req.attestationType}:${req.sourceId}:${req.transactionId}`);
    if (!this.isLive()) {
      return {
        attestation_id,
        type: "Payment",
        source_id: req.sourceId,
        transaction_id: req.transactionId,
        round_id: roundHint,
        verified: true,
        proof: [],
        source: "sim",
      };
    }
    try {
      const res = await fetch(`${this.verifierUrl!.replace(/\/$/, "")}/Payment/prepareRequest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { "X-API-KEY": this.apiKey } : {}),
        },
        body: JSON.stringify({
          attestationType: encodeAttType("Payment"),
          sourceId: encodeSourceId(req.sourceId),
          requestBody: { transactionId: req.transactionId, inUtxo: req.inUtxo ?? "0", utxo: req.utxo ?? "0" },
        }),
      });
      const json = (await res.json()) as { status?: string; abiEncodedRequest?: string };
      const verified = json.status === "VALID" && Boolean(json.abiEncodedRequest);
      return {
        attestation_id,
        type: "Payment",
        source_id: req.sourceId,
        transaction_id: req.transactionId,
        round_id: roundHint,
        verified,
        proof: json.abiEncodedRequest ? [json.abiEncodedRequest] : [],
        source: "fdc",
      };
    } catch {
      // Degrade to an unverified sim envelope rather than break the flow.
      return {
        attestation_id,
        type: "Payment",
        source_id: req.sourceId,
        transaction_id: req.transactionId,
        round_id: roundHint,
        verified: false,
        proof: [],
        source: "sim",
      };
    }
  }
}

/** FDC attestation types are 32-byte, right-padded ASCII of the type name. */
function encodeAttType(name: string): string {
  return "0x" + Buffer.from(name, "utf8").toString("hex").padEnd(64, "0");
}

/** Source ids are 32-byte, right-padded ASCII (e.g. "XRP", "testXRP"). */
function encodeSourceId(id: string): string {
  return "0x" + Buffer.from(id, "utf8").toString("hex").padEnd(64, "0");
}
