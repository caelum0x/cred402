import { createHash } from "node:crypto";
import {
  verifyCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../../../crosschain/standards/credit_notes.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Encode bytes as base58 (Solana signatures/addresses are base58 strings). */
function base58(bytes: Buffer): string {
  let num = BigInt("0x" + (bytes.toString("hex") || "0"));
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58[rem] + out;
  }
  for (const b of bytes) {
    if (b === 0) out = "1" + out;
    else break;
  }
  return out || "1";
}

/** A Solana tx signature: base58 of a sha256 digest of the instruction payload. */
function solanaSignature(payload: string): string {
  return base58(createHash("sha256").update(payload).digest());
}

export interface SolanaVaultDraw {
  agent_id: string;
  amount: bigint;
  note_id: string;
  tx_hash: string;
}

/**
 * SolanaSatelliteVault — an Anchor/SPL credit vault (modeled in TypeScript with the
 * exact verification logic its on-chain Rust program enforces). Like the EVM and
 * Cosmos satellites it lends ONLY against a valid, Casper-policy-signed Credit
 * Authorization Note. Balances are in the SPL token's smallest unit (e.g. USDC has
 * 6 decimals) normalized to USD micro to match the Casper-rooted global cap.
 */
export class SolanaSatelliteVault {
  private liquidity: bigint;
  private readonly debt = new Map<string, bigint>();
  private readonly consumedNotes = new Set<string>();
  private readonly draws: SolanaVaultDraw[] = [];

  constructor(
    readonly chainId: string, // e.g. "solana:mainnet"
    readonly programAddress: string, // base58 program/PDA, e.g. "Cred402Vau1t..."
    readonly casperPolicyPubHex: string,
    initialLiquidity: bigint,
    readonly mint = "USDC",
  ) {
    this.liquidity = initialLiquidity;
  }

  verifyNote(note: CreditAuthorizationNote, now: number): { ok: boolean; reason?: string } {
    return verifyCreditAuthorizationNote(note, this.casperPolicyPubHex, {
      now,
      target_chain: this.chainId,
      target_pool: this.programAddress,
    });
  }

  /** Execute a `draw_credit` instruction against a CAN. Reverts if the note is
   * invalid, replayed, over-limit, or the vault is short on liquidity. */
  draw(note: CreditAuthorizationNote, amount: bigint, now: number): SolanaVaultDraw {
    const check = this.verifyNote(note, now);
    if (!check.ok) throw new Error(`anchor: ${check.reason}`);
    if (this.consumedNotes.has(note.note_id)) throw new Error("anchor: note already consumed");
    if (amount > BigInt(note.max_draw)) throw new Error("anchor: amount exceeds CAN max_draw");
    if (amount > this.liquidity) throw new Error("anchor: insufficient liquidity");

    this.consumedNotes.add(note.note_id);
    this.liquidity -= amount;
    this.debt.set(note.agent_id, (this.debt.get(note.agent_id) ?? 0n) + amount);
    const tx_hash = solanaSignature(`draw:${note.note_id}:${note.agent_id}:${amount}:${now}`);
    const draw: SolanaVaultDraw = { agent_id: note.agent_id, amount, note_id: note.note_id, tx_hash };
    this.draws.push(draw);
    return draw;
  }

  repay(agent_id: string, amount: bigint, now: number): { tx_hash: string; remaining: bigint } {
    const owed = this.debt.get(agent_id) ?? 0n;
    const paid = amount > owed ? owed : amount;
    this.debt.set(agent_id, owed - paid);
    this.liquidity += paid;
    return { tx_hash: solanaSignature(`repay:${agent_id}:${paid}:${now}`), remaining: owed - paid };
  }

  debtOf(agent_id: string): bigint {
    return this.debt.get(agent_id) ?? 0n;
  }
  availableLiquidity(): bigint {
    return this.liquidity;
  }
  drawHistory(): SolanaVaultDraw[] {
    return [...this.draws];
  }
}

export { solanaSignature };
