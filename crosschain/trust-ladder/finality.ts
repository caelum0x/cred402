/**
 * Finality policy (p4 §26 Stage 3 — light-client verification).
 *
 * Before the Casper root accepts a relayed fact, the origin chain's event must
 * be final under a chain-specific policy: enough confirmations AND enough
 * wall-clock seconds since it was observed. This is the honest middle of the
 * trust ladder — not yet a light client, but no longer "trust the relayer
 * instantly". Reorg-prone chains get conservative thresholds.
 */

export interface ChainFinalityConfig {
  chain: string;
  min_confirmations: number; // heights/blocks since the event height
  min_seconds: number; // wall-clock seconds since observation
}

/** Conservative defaults per chain family. */
export const DEFAULT_FINALITY: Record<string, ChainFinalityConfig> = {
  casper: { chain: "casper", min_confirmations: 1, min_seconds: 16 },
  "eip155:8453": { chain: "eip155:8453", min_confirmations: 20, min_seconds: 24 }, // Base ~1.5s blocks
  "eip155:1": { chain: "eip155:1", min_confirmations: 12, min_seconds: 180 }, // Ethereum L1
  solana: { chain: "solana", min_confirmations: 32, min_seconds: 13 },
  cosmos: { chain: "cosmos", min_confirmations: 1, min_seconds: 6 }, // instant finality
};

export interface FinalityCheck {
  final: boolean;
  reason?: string;
}

export class FinalityPolicy {
  constructor(private readonly configs: Record<string, ChainFinalityConfig> = DEFAULT_FINALITY) {}

  config(chain: string): ChainFinalityConfig {
    return this.configs[chain] ?? { chain, min_confirmations: 64, min_seconds: 600 }; // unknown → very conservative
  }

  /** Is an event observed at `observedHeight`/`observedAt` final as of `head`/`now`? */
  isFinal(chain: string, observedHeight: number, head: number, observedAt: number, now: number): FinalityCheck {
    const cfg = this.config(chain);
    const confirmations = head - observedHeight;
    if (confirmations < cfg.min_confirmations) {
      return { final: false, reason: `only ${confirmations}/${cfg.min_confirmations} confirmations on ${chain}` };
    }
    const age = now - observedAt;
    if (age < cfg.min_seconds) {
      return { final: false, reason: `only ${age}s/${cfg.min_seconds}s elapsed on ${chain}` };
    }
    return { final: true };
  }
}
