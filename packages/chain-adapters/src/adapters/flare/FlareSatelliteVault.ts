import { keccak256 } from "../../../../../lib/x402/evm.js";
import {
  verifyCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../../../crosschain/standards/credit_notes.js";
import { FtsoPriceClient } from "./ftso.js";
import { FXRP, fxrpValueUsd } from "./fassets.js";

export interface FlareVaultDraw {
  agent_id: string;
  amount: bigint; // FXRP smallest units (6 dp)
  usd_6dp: bigint; // USD value at draw time (FTSO-priced)
  xrp_usd: number; // the FTSO XRP/USD rate used
  price_source: string; // "ftso" | "sim"
  note_id: string;
  tx_hash: string;
}

/**
 * FlareSatelliteVault — a Flare-side credit vault that lends the interoperable
 * FAsset FXRP. It mirrors the exact verification its Solidity counterpart enforces
 * (see contracts/flare/src/Cred402FlareCreditVault.sol): it lends ONLY against a
 * valid, Casper-policy-signed Credit Authorization Note, and it prices every draw
 * in USD from the live FTSO XRP/USD feed so the shared global-exposure cap is
 * enforced in one denominator across all satellites.
 *
 * Flare executes credit in XRP liquidity; Casper approves credit; FTSO prices it.
 */
export class FlareSatelliteVault {
  private liquidity: bigint; // FXRP smallest units
  private readonly debt = new Map<string, bigint>();
  private readonly consumedNotes = new Set<string>();
  private readonly draws: FlareVaultDraw[] = [];
  readonly ftso: FtsoPriceClient;

  constructor(
    readonly chainId: string,
    readonly poolAddress: string,
    readonly casperPolicyPubHex: string,
    initialLiquidityFxrp: bigint,
    ftso?: FtsoPriceClient,
  ) {
    this.liquidity = initialLiquidityFxrp;
    this.ftso = ftso ?? new FtsoPriceClient();
  }

  verifyNote(note: CreditAuthorizationNote, now: number): { ok: boolean; reason?: string } {
    return verifyCreditAuthorizationNote(note, this.casperPolicyPubHex, {
      now,
      target_chain: this.chainId,
      target_pool: this.poolAddress,
    });
  }

  /**
   * Draw FXRP against a CAN. Reverts if the note is invalid, replayed, over-limit,
   * or the vault is short on liquidity. The draw is priced in USD via FTSO so the
   * Casper root can reconcile it against the agent's global exposure cap.
   */
  async draw(note: CreditAuthorizationNote, amount: bigint, now: number): Promise<FlareVaultDraw> {
    const check = this.verifyNote(note, now);
    if (!check.ok) throw new Error(`flare vault: ${check.reason}`);
    if (note.asset !== FXRP.symbol) throw new Error(`flare vault: CAN asset ${note.asset} != FXRP`);
    if (this.consumedNotes.has(note.note_id)) throw new Error("flare vault: note already consumed");
    if (amount > this.liquidity) throw new Error("flare vault: insufficient FXRP liquidity");

    // The CAN authorizes a USD limit; the vault lends FXRP. Price the draw via FTSO
    // and enforce the limit (and the shared global-exposure cap) in USD — the single
    // denominator across every satellite. max_draw is USD micro (6 dp), like USDC.
    const { usd_6dp, xrp_usd, source } = await fxrpValueUsd(amount, this.ftso);
    if (usd_6dp > BigInt(note.max_draw)) throw new Error("flare vault: USD value exceeds CAN max_draw");

    this.consumedNotes.add(note.note_id);
    this.liquidity -= amount;
    this.debt.set(note.agent_id, (this.debt.get(note.agent_id) ?? 0n) + amount);
    const tx_hash = keccak256(`flaredraw:${note.note_id}:${note.agent_id}:${amount}:${now}`);
    const draw: FlareVaultDraw = {
      agent_id: note.agent_id,
      amount,
      usd_6dp,
      xrp_usd,
      price_source: source,
      note_id: note.note_id,
      tx_hash,
    };
    this.draws.push(draw);
    return draw;
  }

  /**
   * Repay FXRP debt. Returns the FTSO-priced USD value of the amount actually paid so
   * the Casper root reduces the shared global exposure in the SAME USD denominator it
   * was reserved in — never in raw FXRP token units.
   */
  async repay(agent_id: string, amount: bigint, now: number): Promise<{ tx_hash: string; remaining: bigint; paid: bigint; usd_6dp: bigint }> {
    const owed = this.debt.get(agent_id) ?? 0n;
    const paid = amount > owed ? owed : amount;
    this.debt.set(agent_id, owed - paid);
    this.liquidity += paid;
    const { usd_6dp } = await fxrpValueUsd(paid, this.ftso);
    return { tx_hash: keccak256(`flarerepay:${agent_id}:${paid}:${now}`), remaining: owed - paid, paid, usd_6dp };
  }

  /** Reverse a draw whose on-chain execution failed — keeps the JS mirror consistent
   * with the (never-executed) on-chain contract. */
  rollbackDraw(draw: FlareVaultDraw): void {
    if (!this.consumedNotes.has(draw.note_id)) return;
    this.consumedNotes.delete(draw.note_id);
    this.liquidity += draw.amount;
    this.debt.set(draw.agent_id, (this.debt.get(draw.agent_id) ?? 0n) - draw.amount);
    const i = this.draws.findIndex((d) => d.tx_hash === draw.tx_hash);
    if (i >= 0) this.draws.splice(i, 1);
  }

  /** Reverse a repay whose on-chain execution failed. */
  rollbackRepay(agent_id: string, paid: bigint): void {
    this.debt.set(agent_id, (this.debt.get(agent_id) ?? 0n) + paid);
    this.liquidity -= paid;
  }

  debtOf(agent_id: string): bigint {
    return this.debt.get(agent_id) ?? 0n;
  }
  availableLiquidity(): bigint {
    return this.liquidity;
  }
  drawHistory(): FlareVaultDraw[] {
    return [...this.draws];
  }
}
