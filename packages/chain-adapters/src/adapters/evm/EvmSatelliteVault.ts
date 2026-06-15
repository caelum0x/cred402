import { keccak256 } from "../../../../../lib/x402/evm.js";
import {
  verifyCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../../../crosschain/standards/credit_notes.js";

export interface VaultDraw {
  agent_id: string;
  amount: bigint;
  note_id: string;
  tx_hash: string;
}

/**
 * EvmSatelliteVault — a real EVM-side credit vault (modeled in TypeScript with the
 * exact verification logic its Solidity counterpart enforces, see
 * contracts/evm/src/Cred402CreditVault.sol). It lends ONLY against a valid,
 * Casper-policy-signed Credit Authorization Note: EVM executes credit, Casper
 * approves credit.
 */
export class EvmSatelliteVault {
  private liquidity: bigint;
  private readonly debt = new Map<string, bigint>();
  private readonly consumedNotes = new Set<string>();
  private readonly draws: VaultDraw[] = [];

  constructor(
    readonly chainId: string,
    readonly poolAddress: string,
    readonly casperPolicyPubHex: string,
    initialLiquidity: bigint,
  ) {
    this.liquidity = initialLiquidity;
  }

  verifyNote(note: CreditAuthorizationNote, now: number): { ok: boolean; reason?: string } {
    return verifyCreditAuthorizationNote(note, this.casperPolicyPubHex, {
      now,
      target_chain: this.chainId,
      target_pool: this.poolAddress,
    });
  }

  /** Draw against a CAN. Reverts if the note is invalid, replayed, over-limit, or
   * the vault is short on liquidity. */
  draw(note: CreditAuthorizationNote, amount: bigint, now: number): VaultDraw {
    const check = this.verifyNote(note, now);
    if (!check.ok) throw new Error(`vault: ${check.reason}`);
    if (this.consumedNotes.has(note.note_id)) throw new Error("vault: note already consumed");
    if (amount > BigInt(note.max_draw)) throw new Error("vault: amount exceeds CAN max_draw");
    if (amount > this.liquidity) throw new Error("vault: insufficient liquidity");

    this.consumedNotes.add(note.note_id);
    this.liquidity -= amount;
    this.debt.set(note.agent_id, (this.debt.get(note.agent_id) ?? 0n) + amount);
    const tx_hash = keccak256(`draw:${note.note_id}:${note.agent_id}:${amount}:${now}`);
    const draw: VaultDraw = { agent_id: note.agent_id, amount, note_id: note.note_id, tx_hash };
    this.draws.push(draw);
    return draw;
  }

  repay(agent_id: string, amount: bigint, now: number): { tx_hash: string; remaining: bigint } {
    const owed = this.debt.get(agent_id) ?? 0n;
    const paid = amount > owed ? owed : amount;
    this.debt.set(agent_id, owed - paid);
    this.liquidity += paid;
    return { tx_hash: keccak256(`repay:${agent_id}:${paid}:${now}`), remaining: owed - paid };
  }

  debtOf(agent_id: string): bigint {
    return this.debt.get(agent_id) ?? 0n;
  }
  availableLiquidity(): bigint {
    return this.liquidity;
  }
  drawHistory(): VaultDraw[] {
    return [...this.draws];
  }
}
