import type { Ledger } from "../ledger/ledger.js";

/**
 * Cross-chain credit reconciliation (roadmap p5 — Omnichain credit).
 *
 * Cred402 is "Casper-rooted, chain-executed": an agent's credit is authorized on
 * Casper (the GlobalExposureManager is the single source of truth for how much an
 * agent owes across ALL chains) but the draws/repayments actually happen on
 * satellite chains (EVM, Solana, Cosmos, …). Satellites report their own state
 * back; this service ties those reports to the Casper-rooted exposure record and
 * flags any divergence — the over-borrow failure mode the whole multichain design
 * exists to prevent.
 *
 * The Casper view is authoritative. A satellite report is only trusted to the
 * extent it agrees with Casper; disagreement is an alert, never a silent update.
 */

/** A satellite chain's self-reported outstanding credit for one agent. */
export interface SatelliteReport {
  /** CAIP-2 chain id, e.g. "eip155:8453". */
  chain: string;
  /** Currently drawn-and-unpaid on this satellite (normalized USD micro-units). */
  outstanding: bigint;
}

export interface ChainReconciliation {
  chain: string;
  /** Outstanding the satellite reported for this chain (string units). */
  satellite_outstanding: string;
  /** Credit Authorization Notes Cred402 issued targeting this chain. */
  credit_notes: number;
  /** A satellite reported activity Cred402 never authorized a CAN for. */
  unauthorized: boolean;
}

export interface AgentReconciliation {
  agent_id: string;
  /** Whether a Casper-rooted exposure record exists for the agent. */
  has_exposure: boolean;
  /** No over-cap, no Casper-vs-satellite divergence, not frozen-with-debt. */
  consistent: boolean;
  /** Authoritative outstanding from the GlobalExposureManager (string units). */
  casper_outstanding: string;
  /** Reserved-but-not-yet-drawn on Casper (string units). */
  casper_reserved: string;
  /** Sum of all satellite-reported outstanding (string units). */
  satellite_outstanding: string;
  /** Casper global cap across all chains (string units). */
  max_allowed: string;
  /** max_allowed − outstanding − reserved, clamped at 0 (string units). */
  global_headroom: string;
  /** |casper_outstanding − satellite_outstanding| (string units). */
  discrepancy: string;
  /** The killer invariant breach: outstanding + reserved > max_allowed. */
  over_cap: boolean;
  frozen: boolean;
  chains: ChainReconciliation[];
  /** Human-readable reasons the agent is not consistent (empty when clean). */
  alerts: string[];
  reconciled_at: number;
}

function abs(x: bigint): bigint {
  return x < 0n ? -x : x;
}

export class CrossChainReconciler {
  constructor(private readonly ledger: Ledger) {}

  /** Reconcile one agent's satellite reports against its Casper-rooted exposure. */
  reconcile(agentId: string, reports: SatelliteReport[] = []): AgentReconciliation {
    const now = this.ledger.clock.now();
    const exposure = this.ledger.exposure.get_agent_global_exposure(agentId);

    const satelliteTotal = reports.reduce((sum, r) => sum + (r.outstanding > 0n ? r.outstanding : 0n), 0n);

    // Group the agent's issued CANs by target chain so we can tell which chains
    // Cred402 actually authorized credit on.
    const notesByChain = new Map<string, number>();
    for (const stored of this.ledger.notes.list()) {
      if (stored.note.agent_id !== agentId) continue;
      notesByChain.set(stored.note.target_chain, (notesByChain.get(stored.note.target_chain) ?? 0) + 1);
    }

    const reportChains = new Set(reports.map((r) => r.chain));
    const allChains = new Set<string>([...reportChains, ...notesByChain.keys()]);
    const chains: ChainReconciliation[] = [...allChains]
      .map((chain) => {
        const report = reports.find((r) => r.chain === chain);
        const credit_notes = notesByChain.get(chain) ?? 0;
        const reported = report?.outstanding ?? 0n;
        return {
          chain,
          satellite_outstanding: (reported > 0n ? reported : 0n).toString(),
          credit_notes,
          unauthorized: reported > 0n && credit_notes === 0,
        };
      })
      .sort((a, b) => a.chain.localeCompare(b.chain));

    if (!exposure) {
      // No Casper exposure record. Any satellite-reported debt is unauthorized.
      const alerts: string[] = [];
      if (satelliteTotal > 0n) {
        alerts.push(`satellites report ${satelliteTotal} outstanding but agent has no Casper exposure record`);
      }
      return {
        agent_id: agentId,
        has_exposure: false,
        consistent: satelliteTotal === 0n,
        casper_outstanding: "0",
        casper_reserved: "0",
        satellite_outstanding: satelliteTotal.toString(),
        max_allowed: "0",
        global_headroom: "0",
        discrepancy: satelliteTotal.toString(),
        over_cap: false,
        frozen: false,
        chains,
        alerts,
        reconciled_at: now,
      };
    }

    const committed = exposure.outstanding + exposure.reserved;
    const over_cap = committed > exposure.max_allowed;
    const headroom = exposure.max_allowed > committed ? exposure.max_allowed - committed : 0n;
    const discrepancy = abs(exposure.outstanding - satelliteTotal);

    const alerts: string[] = [];
    if (over_cap) {
      alerts.push(`global exposure cap breached: ${committed} committed > ${exposure.max_allowed} allowed`);
    }
    if (discrepancy > 0n) {
      const dir = satelliteTotal > exposure.outstanding ? "over" : "under";
      alerts.push(
        `satellite outstanding ${satelliteTotal} ${dir}-reports Casper outstanding ${exposure.outstanding} by ${discrepancy}`,
      );
    }
    for (const c of chains) {
      if (c.unauthorized) alerts.push(`satellite ${c.chain} reports credit with no authorizing CAN`);
    }
    if (exposure.frozen && exposure.outstanding > 0n) {
      alerts.push(`agent exposure is frozen with ${exposure.outstanding} still outstanding`);
    }

    return {
      agent_id: agentId,
      has_exposure: true,
      consistent: alerts.length === 0,
      casper_outstanding: exposure.outstanding.toString(),
      casper_reserved: exposure.reserved.toString(),
      satellite_outstanding: satelliteTotal.toString(),
      max_allowed: exposure.max_allowed.toString(),
      global_headroom: headroom.toString(),
      discrepancy: discrepancy.toString(),
      over_cap,
      frozen: exposure.frozen,
      chains,
      alerts,
      reconciled_at: now,
    };
  }

  /**
   * Remaining global credit an agent may still draw across all chains:
   * max_allowed − outstanding − reserved (clamped at 0). This is the number a
   * satellite must respect before opening new credit — the over-borrow guard.
   */
  globalHeadroom(agentId: string): bigint {
    const e = this.ledger.exposure.get_agent_global_exposure(agentId);
    if (!e) return 0n;
    const committed = e.outstanding + e.reserved;
    return e.max_allowed > committed ? e.max_allowed - committed : 0n;
  }

  /**
   * Reconcile every agent with a Casper exposure record. Pass per-agent satellite
   * reports keyed by agent id; agents absent from the map reconcile against an
   * empty report set (i.e. Casper expects no satellite-side debt for them).
   */
  reconcileAll(reportsByAgent: Record<string, SatelliteReport[]> = {}): AgentReconciliation[] {
    return this.ledger.exposure
      .list()
      .map((e) => this.reconcile(e.agent_id, reportsByAgent[e.agent_id] ?? []))
      .sort((a, b) => (a.consistent === b.consistent ? 0 : a.consistent ? 1 : -1));
  }
}
