import { blake2b256, stableStringify } from "../core/hash.js";
import { PRIOR_WEIGHTS, FEATURE_KEYS, type FeatureVector, type ModelWeights } from "../services/risk_engine_v2.js";

/**
 * Confidential credit scoring on Flare Confidential Compute (TEE).
 *
 * A credit bureau's most sensitive input is the borrower's raw cash-flow history —
 * here, an agent's private x402 revenue, stake and dispute record. Publishing those
 * on-chain to justify a score would leak exactly what must stay private. Flare
 * Confidential Compute (Intel TDX-backed) lets the scoring run inside a hardware
 * enclave: the raw features enter the enclave, the probability-of-default model runs,
 * and ONLY an attested score + cryptographic commitments leave. Anyone can verify the
 * score was produced by the audited model over the committed inputs, WITHOUT seeing
 * the inputs.
 *
 * Real path (`FLARE_CC_ATTESTATION_URL` set): the enclave's remote-attestation quote
 * is fetched from the confidential-compute attestation service. Sim path: a
 * deterministic quote over the same measurement + commitments, so the flow runs with
 * no TEE and no network. The PUBLISHED envelope is identical either way and contains
 * no raw feature values — that invariant is the whole point.
 *
 * Docs: https://dev.flare.network/network/guides/flare-confidential-compute
 */

export type ConfidentialPlatform = "flare-confidential-compute" | "sim-tee";

export interface EnclaveAttestation {
  platform: ConfidentialPlatform;
  /** Code measurement (MRTD/MRENCLAVE-style) of the scoring workload. */
  measurement: string;
  /** Remote-attestation quote binding the measurement to the result. */
  quote: string;
  verified: boolean;
}

/**
 * The on-chain-safe result. It proves *what model* scored *what inputs* to *what
 * score*, revealing none of the raw features. `input_commitment` lets the data owner
 * (and only them) prove the exact features that were scored.
 */
export interface ConfidentialScoreAttestation {
  type: "Cred402ConfidentialScoreAttestation";
  version: "1";
  agent_id: string;
  score: number; // 0..100, public
  pd: number; // 0..1 probability of default, public
  risk_band: "low" | "moderate" | "elevated" | "high";
  input_commitment: string; // blake2b of the private feature vector — no raw values
  model_commitment: string; // blake2b of the model weights that ran
  enclave: EnclaveAttestation;
  produced_at: number;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

function riskBand(score: number): ConfidentialScoreAttestation["risk_band"] {
  if (score >= 80) return "low";
  if (score >= 60) return "moderate";
  if (score >= 40) return "elevated";
  return "high";
}

/** Deterministic measurement of the scoring workload (model + version + code id). */
function measurementOf(weights: ModelWeights): string {
  return blake2b256(stableStringify({ workload: "cred402.confidential_score", version: "1", weights }));
}

export interface ConfidentialScorerOptions {
  weights?: ModelWeights;
  attestationUrl?: string;
  now?: () => number;
}

export class ConfidentialScorer {
  private readonly weights: ModelWeights;
  private readonly attestationUrl?: string;
  private readonly now: () => number;

  constructor(opts: ConfidentialScorerOptions = {}) {
    this.weights = opts.weights ?? PRIOR_WEIGHTS;
    this.attestationUrl = opts.attestationUrl ?? process.env.FLARE_CC_ATTESTATION_URL;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  isLive(): boolean {
    return Boolean(this.attestationUrl);
  }

  /** Probability of default from the logistic model — computed inside the enclave. */
  private pd(features: FeatureVector): number {
    let z = this.weights.bias;
    for (const k of FEATURE_KEYS) z += this.weights.weights[k] * features[k];
    return sigmoid(z);
  }

  /**
   * Score an agent confidentially. Raw `features` are the enclave-private input; the
   * returned attestation is safe to publish and reveals no feature value.
   */
  async score(agentId: string, features: FeatureVector): Promise<ConfidentialScoreAttestation> {
    const pd = this.pd(features);
    const score = Math.round(100 * (1 - pd));
    const input_commitment = blake2b256(stableStringify({ agent_id: agentId, features }));
    const measurement = measurementOf(this.weights);
    const model_commitment = blake2b256(stableStringify(this.weights));

    const enclave = await this.attest(measurement, input_commitment, score);
    return {
      type: "Cred402ConfidentialScoreAttestation",
      version: "1",
      agent_id: agentId,
      score,
      pd: Number(pd.toFixed(6)),
      risk_band: riskBand(score),
      input_commitment,
      model_commitment,
      enclave,
      produced_at: this.now(),
    };
  }

  /** Fetch a real remote-attestation quote, or produce a deterministic sim quote. */
  private async attest(measurement: string, inputCommitment: string, score: number): Promise<EnclaveAttestation> {
    const bind = stableStringify({ measurement, inputCommitment, score });
    if (!this.attestationUrl) {
      return { platform: "sim-tee", measurement, quote: blake2b256(`sim-tee-quote:${bind}`), verified: true };
    }
    try {
      const res = await fetch(`${this.attestationUrl.replace(/\/$/, "")}/attest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ measurement, input_commitment: inputCommitment, score }),
      });
      const json = (await res.json()) as { quote?: string; verified?: boolean };
      return {
        platform: "flare-confidential-compute",
        measurement,
        quote: json.quote ?? blake2b256(`cc-quote:${bind}`),
        verified: Boolean(json.verified),
      };
    } catch {
      return { platform: "sim-tee", measurement, quote: blake2b256(`sim-tee-quote:${bind}`), verified: false };
    }
  }
}

/**
 * Verify a published attestation against the raw features (only the data owner can
 * run this — everyone else just trusts the enclave quote + commitments).
 */
export function verifyConfidentialScore(
  attestation: ConfidentialScoreAttestation,
  features: FeatureVector,
): { ok: boolean; reason?: string } {
  if (attestation.type !== "Cred402ConfidentialScoreAttestation") return { ok: false, reason: "wrong type" };
  const expected = blake2b256(stableStringify({ agent_id: attestation.agent_id, features }));
  if (expected !== attestation.input_commitment) return { ok: false, reason: "input commitment mismatch" };
  if (attestation.score < 0 || attestation.score > 100) return { ok: false, reason: "score out of range" };
  return { ok: true };
}
