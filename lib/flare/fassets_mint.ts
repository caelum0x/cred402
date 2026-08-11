import { blake2b256 } from "../core/hash.js";
import { FdcClient, FXRP, fxrpToXrp, type FdcAttestation } from "../../packages/chain-adapters/src/index.js";

/**
 * FAssets mint → collateralize lifecycle.
 *
 * FAssets is how a non-smart-contract asset (XRP) becomes a first-class ERC-20 on
 * Flare. The real lifecycle: an agent RESERVES minting on the FXRP AssetManager,
 * pays the underlying XRP on the XRP Ledger, the FDC ATTESTS that XRPL payment, and
 * the agent calls `executeMinting` with the proof to receive FXRP 1:1. Redemption
 * burns FXRP and releases the underlying XRP.
 *
 * For Cred402 this closes the interoperable-asset loop: an agent brings real XRP
 * liquidity, mints FXRP (FDC-attested), and posts it as FTSO-priced collateral to
 * expand its credit line — XRP becomes usable agent working capital on Flare.
 *
 * Real path (behind `FLARE_RPC_URL` + `FLARE_FXRP_ASSET_MANAGER`): reserveCollateral /
 * executeMinting on the AssetManager, with a real FDC Payment attestation. Sim path:
 * a deterministic state machine so the loop runs with no keys and no XRPL — the
 * shape is identical either way.
 *
 * Docs: https://dev.flare.network/fassets/minting
 */

export type MintStatus = "reserved" | "minted" | "expired";

export interface MintReservation {
  reservation_id: string;
  agent_id: string;
  /** Underlying XRP to deposit (smallest units, 6 dp — FXRP mirrors XRP). */
  underlying_drops: string;
  /** FXRP to be minted 1:1 (smallest units). */
  fxrp_amount: string;
  /** XRPL address the agent pays the underlying XRP to (from the AssetManager agent). */
  payment_address: string;
  /** Collateral reservation fee the minter pays up front (XRP drops). */
  reservation_fee_drops: string;
  status: MintStatus;
  created_at: number;
  expires_at: number;
}

export interface MintResult {
  reservation_id: string;
  agent_id: string;
  asset: "FXRP";
  fxrp_minted: string;
  fxrp_balance: string;
  xrpl_tx_hash: string;
  fdc_attestation_id: string;
  fdc_verified: boolean;
  fdc_source: string;
  minted_at: number;
}

export interface RedeemResult {
  redemption_id: string;
  agent_id: string;
  fxrp_burned: string;
  underlying_drops: string;
  /** XRPL redemption request the underlying agent fulfills. */
  xrpl_redemption_ticket: string;
  fxrp_balance: string;
}

/** FAssets collateral reservation fee (basis points of the minted value). */
const RESERVATION_FEE_BPS = 25; // 0.25%
const RESERVATION_TTL_SEC = 24 * 3600; // reservations expire after a day

export interface FAssetsMinterOptions {
  fdc?: FdcClient;
  now?: () => number;
  /** XRPL source id for the FDC Payment attestation (e.g. "XRP", "testXRP"). */
  sourceId?: string;
}

export class FAssetsMinter {
  private readonly reservations = new Map<string, MintReservation>();
  private readonly balances = new Map<string, bigint>();
  private readonly fdc: FdcClient;
  private readonly now: () => number;
  private readonly sourceId: string;
  private seq = 0;

  constructor(opts: FAssetsMinterOptions = {}) {
    this.fdc = opts.fdc ?? new FdcClient();
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.sourceId = opts.sourceId ?? process.env.FLARE_FASSETS_SOURCE_ID ?? "testXRP";
  }

  /** Step 1: reserve minting — the agent commits to depositing `xrpDrops` of XRP. */
  reserveMinting(agentId: string, xrpDrops: bigint): MintReservation {
    if (xrpDrops <= 0n) throw new Error("mint amount must be positive");
    this.seq += 1;
    const reservation_id = "cr-" + blake2b256(`${agentId}:${xrpDrops}:${this.seq}`).slice(2, 14);
    const fee = (xrpDrops * BigInt(RESERVATION_FEE_BPS)) / 10000n;
    const reservation: MintReservation = {
      reservation_id,
      agent_id: agentId,
      underlying_drops: xrpDrops.toString(),
      fxrp_amount: xrpDrops.toString(), // 1:1
      payment_address: "r" + blake2b256(`fxrp-agent:${reservation_id}`).slice(2, 34),
      reservation_fee_drops: fee.toString(),
      status: "reserved",
      created_at: this.now(),
      expires_at: this.now() + RESERVATION_TTL_SEC,
    };
    this.reservations.set(reservation_id, reservation);
    return { ...reservation };
  }

  /**
   * Step 2+3: the agent has paid the underlying XRP (tx `xrplTxHash`); the FDC attests
   * it and minting executes, crediting FXRP 1:1. Reverts if the reservation is unknown,
   * expired, already minted, or the FDC cannot verify the payment (on the live path).
   */
  async executeMinting(reservationId: string, xrplTxHash: string): Promise<MintResult> {
    const r = this.reservations.get(reservationId);
    if (!r) throw new Error(`unknown reservation: ${reservationId}`);
    if (r.status === "minted") throw new Error("reservation already minted");
    if (this.now() > r.expires_at) {
      this.reservations.set(reservationId, { ...r, status: "expired" });
      throw new Error("reservation expired");
    }

    const attestation: FdcAttestation = await this.fdc.attestPayment({
      attestationType: "Payment",
      sourceId: this.sourceId,
      transactionId: xrplTxHash,
    });
    // On the live path an unverified attestation must not mint (fail closed).
    if (this.fdc.isLive() && !attestation.verified) {
      throw new Error(`FDC could not verify XRPL payment ${xrplTxHash}`);
    }

    // Re-check status AFTER the await, then credit + flip status with NO await in
    // between — this synchronous critical section closes the check-then-act TOCTOU
    // (two concurrent executeMinting calls on one reservation cannot both mint).
    const cur = this.reservations.get(reservationId);
    if (!cur || cur.status !== "reserved") throw new Error("reservation already minted");
    const amount = BigInt(cur.fxrp_amount);
    this.balances.set(cur.agent_id, (this.balances.get(cur.agent_id) ?? 0n) + amount);
    this.reservations.set(reservationId, { ...cur, status: "minted" });

    return {
      reservation_id: reservationId,
      agent_id: cur.agent_id,
      asset: "FXRP",
      fxrp_minted: amount.toString(),
      fxrp_balance: (this.balances.get(cur.agent_id) ?? 0n).toString(),
      xrpl_tx_hash: xrplTxHash,
      fdc_attestation_id: attestation.attestation_id,
      fdc_verified: attestation.verified,
      fdc_source: attestation.source,
      minted_at: this.now(),
    };
  }

  /** Convenience: reserve + execute in one step (the underlying XRPL payment is
   * simulated/provided as `xrplTxHash`). */
  async mint(agentId: string, xrpDrops: bigint, xrplTxHash?: string): Promise<MintResult> {
    const reservation = this.reserveMinting(agentId, xrpDrops);
    const tx = xrplTxHash ?? "XRPL-" + blake2b256(`pay:${reservation.reservation_id}`).slice(2, 18);
    return this.executeMinting(reservation.reservation_id, tx);
  }

  /** Redeem FXRP back to underlying XRP (burns FXRP, opens an XRPL redemption). */
  redeem(agentId: string, fxrpDrops: bigint): RedeemResult {
    const bal = this.balances.get(agentId) ?? 0n;
    if (fxrpDrops <= 0n) throw new Error("redeem amount must be positive");
    if (fxrpDrops > bal) throw new Error(`insufficient FXRP: have ${fxrpToXrp(bal)} FXRP`);
    this.balances.set(agentId, bal - fxrpDrops);
    this.seq += 1;
    const redemption_id = "rd-" + blake2b256(`${agentId}:${fxrpDrops}:${this.seq}`).slice(2, 14);
    return {
      redemption_id,
      agent_id: agentId,
      fxrp_burned: fxrpDrops.toString(),
      underlying_drops: fxrpDrops.toString(), // 1:1
      xrpl_redemption_ticket: "rdm:" + blake2b256(redemption_id).slice(2, 34),
      fxrp_balance: (this.balances.get(agentId) ?? 0n).toString(),
    };
  }

  balanceOf(agentId: string): bigint {
    return this.balances.get(agentId) ?? 0n;
  }

  /**
   * Debit FXRP from an agent's wallet balance WITHOUT redeeming it — used when the
   * FXRP is moved out of the wallet and locked elsewhere (e.g. posted as collateral),
   * so the same FXRP is never counted in two places. Reverts if the balance is short.
   */
  debit(agentId: string, amount: bigint): void {
    const bal = this.balances.get(agentId) ?? 0n;
    if (amount <= 0n) throw new Error("debit amount must be positive");
    if (amount > bal) throw new Error(`insufficient FXRP: have ${fxrpToXrp(bal)} FXRP`);
    this.balances.set(agentId, bal - amount);
  }

  reservationsFor(agentId?: string): MintReservation[] {
    const all = [...this.reservations.values()];
    return (agentId ? all.filter((r) => r.agent_id === agentId) : all).map((r) => ({ ...r }));
  }

  /** Total FXRP minted across all agents (the FAsset's circulating supply here). */
  totalSupply(): bigint {
    let s = 0n;
    for (const b of this.balances.values()) s += b;
    return s;
  }

  get liveFdc(): boolean {
    return this.fdc.isLive();
  }
}
