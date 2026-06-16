import { createHash } from "node:crypto";
import {
  verifyCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../../../crosschain/standards/credit_notes.js";

/** Aptos/Sui tx hashes are 0x-prefixed 32-byte hex digests of the signed tx. */
function moveTxHash(payload: string): string {
  return "0x" + createHash("sha256").update(payload).digest("hex");
}

export interface MoveVaultDraw {
  agent_id: string;
  amount: bigint;
  note_id: string;
  tx_hash: string;
}

/**
 * MoveSatelliteVault — a Move (Aptos/Sui) credit resource account, modeled in
 * TypeScript with the exact verification logic its on-chain Move module enforces.
 * Like the EVM/Cosmos/Solana satellites it lends ONLY against a valid,
 * Casper-policy-signed Credit Authorization Note. Move's resource model means the
 * vault's coin store is a typed resource; balances are the coin's smallest unit
 * (e.g. USDC octas) normalized to USD micro for the Casper-rooted global cap.
 */
export class MoveSatelliteVault {
  private liquidity: bigint;
  private readonly debt = new Map<string, bigint>();
  private readonly consumedNotes = new Set<string>();
  private readonly draws: MoveVaultDraw[] = [];

  constructor(
    readonly chainId: string, // e.g. "move:aptos-mainnet"
    readonly moduleAddress: string, // 0x-prefixed account/module address
    readonly casperPolicyPubHex: string,
    initialLiquidity: bigint,
    readonly coinType = "0x1::aptos_coin::USDC",
  ) {
    this.liquidity = initialLiquidity;
  }

  verifyNote(note: CreditAuthorizationNote, now: number): { ok: boolean; reason?: string } {
    return verifyCreditAuthorizationNote(note, this.casperPolicyPubHex, {
      now,
      target_chain: this.chainId,
      target_pool: this.moduleAddress,
    });
  }

  /** Execute a `draw_credit` entry function against a CAN. Aborts if the note is
   * invalid, replayed, over-limit, or the resource account is short on liquidity. */
  draw(note: CreditAuthorizationNote, amount: bigint, now: number): MoveVaultDraw {
    const check = this.verifyNote(note, now);
    if (!check.ok) throw new Error(`move: ${check.reason}`);
    if (this.consumedNotes.has(note.note_id)) throw new Error("move: note already consumed");
    if (amount > BigInt(note.max_draw)) throw new Error("move: amount exceeds CAN max_draw");
    if (amount > this.liquidity) throw new Error("move: insufficient liquidity");

    this.consumedNotes.add(note.note_id);
    this.liquidity -= amount;
    this.debt.set(note.agent_id, (this.debt.get(note.agent_id) ?? 0n) + amount);
    const tx_hash = moveTxHash(`draw:${note.note_id}:${note.agent_id}:${amount}:${now}`);
    const draw: MoveVaultDraw = { agent_id: note.agent_id, amount, note_id: note.note_id, tx_hash };
    this.draws.push(draw);
    return draw;
  }

  repay(agent_id: string, amount: bigint, now: number): { tx_hash: string; remaining: bigint } {
    const owed = this.debt.get(agent_id) ?? 0n;
    const paid = amount > owed ? owed : amount;
    this.debt.set(agent_id, owed - paid);
    this.liquidity += paid;
    return { tx_hash: moveTxHash(`repay:${agent_id}:${paid}:${now}`), remaining: owed - paid };
  }

  debtOf(agent_id: string): bigint {
    return this.debt.get(agent_id) ?? 0n;
  }
  availableLiquidity(): bigint {
    return this.liquidity;
  }
  drawHistory(): MoveVaultDraw[] {
    return [...this.draws];
  }
}

export { moveTxHash };
