import { createHash } from "node:crypto";
import {
  verifyCreditAuthorizationNote,
  type CreditAuthorizationNote,
} from "../../../../../crosschain/standards/credit_notes.js";

/** Cosmos tx hashes are uppercase hex SHA-256 digests of the tx bytes. */
function cosmosTxHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex").toUpperCase();
}

export interface CosmosVaultDraw {
  agent_id: string;
  amount: bigint;
  note_id: string;
  tx_hash: string;
}

/**
 * CosmosSatelliteVault — a CosmWasm credit vault (modeled in TypeScript with the
 * exact verification logic its Rust/CosmWasm counterpart enforces). Like the EVM
 * satellite it lends ONLY against a valid, Casper-policy-signed Credit
 * Authorization Note: Cosmos executes credit, Casper approves credit. Balances are
 * denominated in the IBC asset's smallest unit (e.g. uusdc), normalized to USD
 * micro to match the Casper-rooted global exposure cap.
 */
export class CosmosSatelliteVault {
  private liquidity: bigint;
  private readonly debt = new Map<string, bigint>();
  private readonly consumedNotes = new Set<string>();
  private readonly draws: CosmosVaultDraw[] = [];

  constructor(
    readonly chainId: string, // e.g. "cosmos:cosmoshub-4"
    readonly contractAddress: string, // bech32 cosmwasm contract, e.g. "cosmos1vault..."
    readonly casperPolicyPubHex: string,
    initialLiquidity: bigint,
    readonly denom = "uusdc",
  ) {
    this.liquidity = initialLiquidity;
  }

  verifyNote(note: CreditAuthorizationNote, now: number): { ok: boolean; reason?: string } {
    return verifyCreditAuthorizationNote(note, this.casperPolicyPubHex, {
      now,
      target_chain: this.chainId,
      target_pool: this.contractAddress,
    });
  }

  /** Execute a MsgDrawCredit against a CAN. Reverts if the note is invalid,
   * replayed, over-limit, or the contract is short on liquidity. */
  draw(note: CreditAuthorizationNote, amount: bigint, now: number): CosmosVaultDraw {
    const check = this.verifyNote(note, now);
    if (!check.ok) throw new Error(`cosmwasm: ${check.reason}`);
    if (this.consumedNotes.has(note.note_id)) throw new Error("cosmwasm: note already consumed");
    if (amount > BigInt(note.max_draw)) throw new Error("cosmwasm: amount exceeds CAN max_draw");
    if (amount > this.liquidity) throw new Error("cosmwasm: insufficient liquidity");

    this.consumedNotes.add(note.note_id);
    this.liquidity -= amount;
    this.debt.set(note.agent_id, (this.debt.get(note.agent_id) ?? 0n) + amount);
    const tx_hash = cosmosTxHash(`draw:${note.note_id}:${note.agent_id}:${amount}:${now}`);
    const draw: CosmosVaultDraw = { agent_id: note.agent_id, amount, note_id: note.note_id, tx_hash };
    this.draws.push(draw);
    return draw;
  }

  repay(agent_id: string, amount: bigint, now: number): { tx_hash: string; remaining: bigint } {
    const owed = this.debt.get(agent_id) ?? 0n;
    const paid = amount > owed ? owed : amount;
    this.debt.set(agent_id, owed - paid);
    this.liquidity += paid;
    return { tx_hash: cosmosTxHash(`repay:${agent_id}:${paid}:${now}`), remaining: owed - paid };
  }

  debtOf(agent_id: string): bigint {
    return this.debt.get(agent_id) ?? 0n;
  }
  availableLiquidity(): bigint {
    return this.liquidity;
  }
  drawHistory(): CosmosVaultDraw[] {
    return [...this.draws];
  }
}

export { cosmosTxHash };
