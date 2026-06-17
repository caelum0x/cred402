import type { Ledger } from "../ledger/ledger.js";
import type { Verdict } from "../core/protocol_types.js";
import { blake2b256 } from "../core/hash.js";

/**
 * Decentralized dispute jury (roadmap p6 — Decentralization & data moat).
 *
 * Today a verdict is issued by the DisputeCourt after a single judge agent
 * recommends it. p6 decentralizes that authority: a panel of staked, reputable
 * agents is empaneled per dispute, each juror votes a verdict, and the majority
 * decision is what gets issued on-chain. Jurors who vote with the consensus earn
 * reputation; those who vote against it or no-show are penalized — a stake/rep
 * incentive to adjudicate honestly. Panel selection is deterministic and rooted in
 * the dispute id, so it is verifiable and reproducible (no hidden randomness).
 */

/** A verdict a juror may cast. Slashing verdicts carry a proposed slash amount. */
export type JurorVerdict = Extract<Verdict, "agent_loses" | "agent_wins" | "partial_fault">;

export interface JurorVote {
  juror: string;
  verdict: JurorVerdict;
  proposed_slash_motes: bigint;
  rationale: string;
  cast_at: number;
}

export interface JuryPanel {
  dispute_id: string;
  jurors: string[];
  empaneled_at: number;
}

export interface JurorTally {
  juror: string;
  verdict: JurorVerdict;
  with_majority: boolean;
}

export interface JuryOutcome {
  dispute_id: string;
  verdict: Verdict;
  slash_amount_motes: string;
  panel_size: number;
  votes_cast: number;
  majority_size: number;
  quorum_met: boolean;
  resolved: boolean; // whether a verdict was issued on the DisputeCourt
  tallies: JurorTally[];
  rewarded: string[]; // jurors who voted with the majority
  penalized: string[]; // empaneled jurors who voted against consensus or no-showed
}

export interface JuryConfig {
  panel_size: number;
  min_stake_motes: bigint;
  min_reputation: number;
  /** Fraction of the panel that must vote for a tally to be valid (bps). */
  quorum_bps: number;
  /** Reputation delta for jurors who vote with the majority. */
  juror_reward: number;
  /** Reputation delta (negative) for jurors against consensus or absent. */
  juror_penalty: number;
}

export const DEFAULT_JURY_CONFIG: JuryConfig = {
  panel_size: 5,
  min_stake_motes: 10n * 1_000_000_000n, // 10 CSPR staked to be juror-eligible
  min_reputation: 60,
  quorum_bps: 6000, // 60% of the panel must vote
  juror_reward: 2,
  juror_penalty: -3,
};

export class DisputeJury {
  private readonly panels = new Map<string, JuryPanel>();
  private readonly votes = new Map<string, Map<string, JurorVote>>();
  private readonly cfg: JuryConfig;

  constructor(
    private readonly ledger: Ledger,
    cfg: Partial<JuryConfig> = {},
  ) {
    this.cfg = { ...DEFAULT_JURY_CONFIG, ...cfg };
  }

  /** Agents eligible to serve on a panel: staked, reputable, active, and not a
   * party to the dispute. */
  private eligibleJurors(disputeId: string): string[] {
    const dispute = this.ledger.disputes.get(disputeId);
    if (!dispute) throw new Error(`unknown dispute: ${disputeId}`);
    const parties = new Set([dispute.complainant, dispute.respondent_agent]);
    return this.ledger.agents
      .list()
      .filter(
        (a) =>
          a.active &&
          !parties.has(a.agent_id) &&
          a.reputation_score >= this.cfg.min_reputation &&
          a.stake >= this.cfg.min_stake_motes,
      )
      .map((a) => a.agent_id);
  }

  /**
   * Empanel a verifiable juror set for a dispute. Selection is deterministic:
   * eligible agents are ranked by blake2b256(dispute_id:agent_id), so anyone can
   * recompute and audit the panel, yet no agent can predict/grind their seat
   * before the dispute id exists.
   */
  empanel(disputeId: string): JuryPanel {
    if (this.panels.has(disputeId)) return { ...this.panels.get(disputeId)!, jurors: [...this.panels.get(disputeId)!.jurors] };
    const ranked = this.eligibleJurors(disputeId)
      .map((id) => ({ id, seed: blake2b256(`${disputeId}:${id}`) }))
      .sort((a, b) => (a.seed < b.seed ? -1 : a.seed > b.seed ? 1 : 0))
      .slice(0, this.cfg.panel_size)
      .map((x) => x.id);
    const panel: JuryPanel = { dispute_id: disputeId, jurors: ranked, empaneled_at: this.ledger.clock.now() };
    this.panels.set(disputeId, panel);
    this.votes.set(disputeId, new Map());
    return { ...panel, jurors: [...panel.jurors] };
  }

  /** Cast a juror's vote. The juror must be on the empaneled panel; one vote each. */
  castVote(disputeId: string, juror: string, verdict: JurorVerdict, opts: { proposed_slash_motes?: bigint; rationale?: string } = {}): JurorVote {
    const panel = this.panels.get(disputeId);
    if (!panel) throw new Error(`no panel empaneled for dispute ${disputeId}`);
    if (!panel.jurors.includes(juror)) throw new Error(`${juror} is not on the panel for ${disputeId}`);
    const ballots = this.votes.get(disputeId)!;
    if (ballots.has(juror)) throw new Error(`${juror} already voted on ${disputeId}`);
    if (verdict === "agent_wins" && opts.proposed_slash_motes && opts.proposed_slash_motes > 0n) {
      throw new Error("an agent_wins vote cannot propose a slash");
    }
    const vote: JurorVote = {
      juror,
      verdict,
      proposed_slash_motes: verdict === "agent_wins" ? 0n : opts.proposed_slash_motes ?? 0n,
      rationale: opts.rationale ?? "",
      cast_at: this.ledger.clock.now(),
    };
    ballots.set(juror, vote);
    return { ...vote };
  }

  /**
   * Tally the panel: the plurality verdict wins (ties resolve in the agent's
   * favor), the issued slash is the median proposed by majority jurors, the
   * verdict is issued on the DisputeCourt, and jurors are rewarded/penalized by
   * whether they voted with consensus.
   */
  tally(disputeId: string): JuryOutcome {
    const panel = this.panels.get(disputeId);
    if (!panel) throw new Error(`no panel empaneled for dispute ${disputeId}`);
    const ballots = [...this.votes.get(disputeId)!.values()];
    const panelSize = panel.jurors.length;
    const needed = Math.ceil((panelSize * this.cfg.quorum_bps) / 10000);
    const quorum_met = ballots.length >= needed && panelSize > 0;

    // Plurality verdict; tie or no quorum resolves to agent_wins (benefit of doubt).
    const counts = new Map<JurorVerdict, number>();
    for (const v of ballots) counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
    let verdict: JurorVerdict = "agent_wins";
    let top = 0;
    for (const [vd, n] of counts) {
      if (n > top) {
        top = n;
        verdict = vd;
      }
    }
    if (!quorum_met) verdict = "agent_wins";

    const majorityVotes = ballots.filter((v) => v.verdict === verdict);
    const slashAmount =
      verdict === "agent_wins" ? 0n : median(majorityVotes.map((v) => v.proposed_slash_motes));

    const rewarded: string[] = [];
    const penalized: string[] = [];
    const tallies: JurorTally[] = [];
    for (const juror of panel.jurors) {
      const ballot = this.votes.get(disputeId)!.get(juror);
      const withMajority = quorum_met && ballot?.verdict === verdict;
      if (ballot) tallies.push({ juror, verdict: ballot.verdict, with_majority: !!withMajority });
      if (withMajority) {
        rewarded.push(juror);
        this.ledger.agents.update_reputation(juror, this.cfg.juror_reward, "0x", "JUROR_CONSENSUS");
      } else {
        penalized.push(juror);
        this.ledger.agents.update_reputation(juror, this.cfg.juror_penalty, "0x", "JUROR_DISSENT_OR_ABSENT");
      }
    }

    let resolved = false;
    if (quorum_met) {
      const rationale = [
        `jury verdict ${verdict} by ${majorityVotes.length}/${panelSize} jurors`,
        ...majorityVotes.filter((v) => v.rationale).map((v) => `${v.juror}: ${v.rationale}`),
      ];
      this.ledger.disputes.issue_verdict(disputeId, verdict, slashAmount, rationale);
      resolved = true;
    }

    return {
      dispute_id: disputeId,
      verdict,
      slash_amount_motes: slashAmount.toString(),
      panel_size: panelSize,
      votes_cast: ballots.length,
      majority_size: majorityVotes.length,
      quorum_met,
      resolved,
      tallies,
      rewarded,
      penalized,
    };
  }

  panel(disputeId: string): JuryPanel | undefined {
    const p = this.panels.get(disputeId);
    return p ? { ...p, jurors: [...p.jurors] } : undefined;
  }
}

function median(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}
