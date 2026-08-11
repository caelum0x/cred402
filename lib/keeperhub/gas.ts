import type { GasEstimate } from "./types.js";

/**
 * SmartGasEstimator — KeeperHub's "transactions execute instead of getting stuck"
 * guarantee, modeled honestly. It prices EIP-1559 fees off the current base fee and,
 * on congestion / cold-start retries, applies EXPONENTIAL BACKOFF to the fee cap so a
 * resubmission clears the mempool instead of stalling. This mirrors what KeeperHub's
 * smart-gas engine does server-side; on the real path we seed it from KeeperHub's
 * `simulate` gas estimate, on the sim path it stands alone.
 */
export interface GasInputs {
  /** Current network base fee (wei). */
  base_fee_wei: bigint;
  /** Miner tip (wei). */
  priority_fee_wei: bigint;
  /** Gas limit from simulation (or a safe default). */
  gas_limit: number;
}

export interface SmartGasOptions {
  /** Fee multiplier applied per backoff attempt (>1). Default 1.25 (25% bumps). */
  backoffFactor?: number;
  /** Max resubmission attempts before giving up. Default 5. */
  maxAttempts?: number;
  /** Base delay (ms) for the exponential retry schedule. Default 500ms. */
  baseDelayMs?: number;
  /** Headroom over base fee for the max-fee cap. Default 2× base + tip. */
  baseFeeHeadroom?: number;
}

const DEFAULTS: Required<SmartGasOptions> = {
  backoffFactor: 1.25,
  maxAttempts: 5,
  baseDelayMs: 500,
  baseFeeHeadroom: 2,
};

export class SmartGasEstimator {
  private readonly opts: Required<SmartGasOptions>;

  constructor(opts: SmartGasOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
    if (this.opts.backoffFactor <= 1) throw new Error("gas: backoffFactor must be > 1");
    if (this.opts.maxAttempts < 1) throw new Error("gas: maxAttempts must be >= 1");
  }

  /**
   * Price fees for a given attempt (0-based). Attempt 0 is the initial submit; each
   * subsequent attempt multiplies both fee components by backoffFactor^attempt so a
   * stuck tx is replaced by one the network will actually include.
   */
  estimate(inputs: GasInputs, attempt = 0): GasEstimate {
    if (attempt >= this.opts.maxAttempts) {
      throw new Error(`gas: exhausted ${this.opts.maxAttempts} backoff attempts`);
    }
    const bump = this.opts.backoffFactor ** attempt;
    const scale = (v: bigint) => (v * BigInt(Math.round(bump * 1000))) / 1000n;
    const priority = scale(inputs.priority_fee_wei);
    // max_fee = headroom × base + priority, all backoff-scaled.
    const maxFee = scale(inputs.base_fee_wei * BigInt(this.opts.baseFeeHeadroom)) + priority;
    return {
      max_fee_per_gas: maxFee.toString(),
      max_priority_fee_per_gas: priority.toString(),
      gas_limit: inputs.gas_limit,
      attempts: attempt + 1,
      strategy: "eip1559-exponential-backoff",
    };
  }

  /** Exponential backoff delay (ms) before resubmitting attempt N. */
  retryDelayMs(attempt: number): number {
    return Math.round(this.opts.baseDelayMs * this.opts.backoffFactor ** attempt);
  }

  get maxAttempts(): number {
    return this.opts.maxAttempts;
  }
}
