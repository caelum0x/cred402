import type { SlashDestination, SlashRecord } from "../../core/protocol_types.js";
import { deployHash, shortId } from "../../core/hash.js";
import { scaleMotes } from "../../core/units.js";
import type { EventBus } from "../events.js";
import type { Clock } from "../clock.js";

const CONTRACT = "SlashingVault";

/**
 * SlashingVault (p2 §6.10) — receives slashed stake and distributes it across
 * destinations: victim reimbursement, insurance reserve, protocol treasury, and
 * (optionally) burn. Keeps an auditable record of every slash.
 */
export class SlashingVault {
  private readonly records: SlashRecord[] = [];
  private readonly reserves: Record<SlashDestination, bigint> = {
    victim_reimbursement: 0n,
    insurance_reserve: 0n,
    protocol_treasury: 0n,
    burn: 0n,
  };

  constructor(
    private readonly bus: EventBus,
    private readonly clock: Clock,
  ) {}

  /**
   * Apply a slash. Default split: 50% to the victim, 30% insurance reserve,
   * 20% protocol treasury (no burn unless governance overrides).
   */
  apply_slash(args: {
    agent_id: string;
    amount: bigint;
    reason: string;
    dispute_id?: string;
    split?: Partial<Record<SlashDestination, number>>;
  }): SlashRecord {
    const split = args.split ?? { victim_reimbursement: 0.5, insurance_reserve: 0.3, protocol_treasury: 0.2 };
    const distribution: Record<SlashDestination, bigint> = {
      victim_reimbursement: scaleMotes(args.amount, split.victim_reimbursement ?? 0),
      insurance_reserve: scaleMotes(args.amount, split.insurance_reserve ?? 0),
      protocol_treasury: scaleMotes(args.amount, split.protocol_treasury ?? 0),
      burn: scaleMotes(args.amount, split.burn ?? 0),
    };
    // assign any rounding dust to the treasury so totals reconcile
    const allocated = Object.values(distribution).reduce((s, v) => s + v, 0n);
    distribution.protocol_treasury += args.amount - allocated;

    for (const k of Object.keys(distribution) as SlashDestination[]) {
      this.reserves[k] += distribution[k];
    }

    const record: SlashRecord = {
      slash_id: shortId("slash"),
      agent_id: args.agent_id,
      amount: args.amount,
      reason: args.reason,
      dispute_id: args.dispute_id,
      distribution,
      timestamp: this.clock.now(),
    };
    this.records.push(record);
    this.bus.emit("StakeSlashedToVault", CONTRACT, deployHash(), {
      slash_id: record.slash_id,
      agent_id: args.agent_id,
      amount: args.amount.toString(),
      dispute_id: args.dispute_id ?? "",
    });
    this.bus.emit("SlashDistributed", CONTRACT, deployHash(), {
      slash_id: record.slash_id,
      victim: distribution.victim_reimbursement.toString(),
      insurance: distribution.insurance_reserve.toString(),
      treasury: distribution.protocol_treasury.toString(),
    });
    return { ...record, distribution: { ...distribution } };
  }

  reserveBalances(): Record<SlashDestination, string> {
    return {
      victim_reimbursement: this.reserves.victim_reimbursement.toString(),
      insurance_reserve: this.reserves.insurance_reserve.toString(),
      protocol_treasury: this.reserves.protocol_treasury.toString(),
      burn: this.reserves.burn.toString(),
    };
  }

  list(): SlashRecord[] {
    return this.records.map((r) => ({ ...r, distribution: { ...r.distribution } }));
  }

  totalSlashed(): bigint {
    return this.records.reduce((s, r) => s + r.amount, 0n);
  }
}
