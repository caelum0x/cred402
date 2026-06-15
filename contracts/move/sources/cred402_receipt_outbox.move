/// Cred402 Move satellite — Receipt Outbox (receipt commitments).
///
/// Every x402 payment settled on this Move satellite becomes a Universal Receipt
/// Envelope (URE) whose canonical id is:
///
///     receipt_id = blake2b256(canonical_json(URE))
///
/// The full URE lives off-chain / on Casper; the satellite only needs to COMMIT to
/// the receipt so that a Casper-side inbox/relayer can later anchor it. This outbox
/// records the 32-byte blake2b-256 receipt_id plus the minimal routing metadata a
/// relayer needs (origin chain, settlement network, payer/seller CAIDs, amount).
///
/// The `receipt_id` MUST be computed exactly as in crosschain/standards/receipts.ts
/// (blake2b-256 over the stable-key-ordered JSON of the URE). This module verifies
/// the commitment shape and prevents duplicate commitments; it does not recompute
/// the hash (the URE body is not carried on-chain), matching the EVM ReceiptOutbox.
module cred402::cred402_receipt_outbox {
    use std::string::String;
    use sui::table::{Self, Table};
    use sui::event;

    // ===== Errors =====
    const EBadReceiptIdLen: u64 = 1;
    const EAmountEmpty: u64 = 2;
    const EReceiptExists: u64 = 3;
    const ENotAdmin: u64 = 4;

    /// blake2b-256 digests are 32 bytes.
    const RECEIPT_ID_LEN: u64 = 32;

    /// A committed receipt (the satellite's attestation that an x402 payment
    /// settled locally and produced this canonical Casper-anchorable receipt id).
    public struct ReceiptCommitment has store, drop, copy {
        receipt_id: vector<u8>,        // 32-byte blake2b256(canonical_json(URE))
        origin_chain: String,          // e.g. "sui:testnet"
        settlement_network: String,    // e.g. "sui"
        payer_agent_id: String,        // CAID
        seller_agent_id: String,       // CAID
        asset: String,                 // "USDC" | ...
        amount: u64,                   // smallest-unit integer (USDC 6dp)
        committed_at_ms: u64,
        sequence: u64,
    }

    /// Shared, append-only outbox.
    public struct ReceiptOutbox has key {
        id: UID,
        admin: address,
        receipts: Table<vector<u8>, ReceiptCommitment>,
        sequence: u64,
    }

    public struct OutboxAdminCap has key, store {
        id: UID,
        outbox: ID,
    }

    public struct ReceiptCommitted has copy, drop {
        receipt_id: vector<u8>,
        payer_agent_id: String,
        seller_agent_id: String,
        amount: u64,
        sequence: u64,
        committed_at_ms: u64,
    }

    public fun init_outbox(ctx: &mut TxContext): OutboxAdminCap {
        let outbox = ReceiptOutbox {
            id: object::new(ctx),
            admin: ctx.sender(),
            receipts: table::new<vector<u8>, ReceiptCommitment>(ctx),
            sequence: 0,
        };
        let cap = OutboxAdminCap { id: object::new(ctx), outbox: object::id(&outbox) };
        transfer::share_object(outbox);
        cap
    }

    public entry fun create(ctx: &mut TxContext) {
        let cap = init_outbox(ctx);
        transfer::public_transfer(cap, ctx.sender());
    }

    fun assert_admin(outbox: &ReceiptOutbox, cap: &OutboxAdminCap, ctx: &TxContext) {
        assert!(cap.outbox == object::id(outbox), ENotAdmin);
        assert!(outbox.admin == ctx.sender(), ENotAdmin);
    }

    /// Commit a receipt. `receipt_id` must be the canonical 32-byte
    /// blake2b256(canonical_json(URE)). Duplicate ids are rejected so each
    /// universal receipt is committed at most once on this satellite.
    public fun commit_receipt(
        outbox: &mut ReceiptOutbox,
        cap: &OutboxAdminCap,
        receipt_id: vector<u8>,
        origin_chain: String,
        settlement_network: String,
        payer_agent_id: String,
        seller_agent_id: String,
        asset: String,
        amount: u64,
        now_ms: u64,
        ctx: &TxContext,
    ): u64 {
        assert_admin(outbox, cap, ctx);
        assert!(vector::length(&receipt_id) == RECEIPT_ID_LEN, EBadReceiptIdLen);
        assert!(amount > 0, EAmountEmpty);
        assert!(!table::contains(&outbox.receipts, receipt_id), EReceiptExists);

        let seq = outbox.sequence;
        let commitment = ReceiptCommitment {
            receipt_id,
            origin_chain,
            settlement_network,
            payer_agent_id,
            seller_agent_id,
            asset,
            amount,
            committed_at_ms: now_ms,
            sequence: seq,
        };
        table::add(&mut outbox.receipts, receipt_id, commitment);
        outbox.sequence = seq + 1;

        event::emit(ReceiptCommitted {
            receipt_id,
            payer_agent_id,
            seller_agent_id,
            amount,
            sequence: seq,
            committed_at_ms: now_ms,
        });
        seq
    }

    // ===== Views =====

    public fun is_committed(outbox: &ReceiptOutbox, receipt_id: &vector<u8>): bool {
        table::contains(&outbox.receipts, *receipt_id)
    }

    public fun amount_of(outbox: &ReceiptOutbox, receipt_id: &vector<u8>): u64 {
        assert!(table::contains(&outbox.receipts, *receipt_id), EReceiptExists);
        table::borrow(&outbox.receipts, *receipt_id).amount
    }

    public fun sequence_of(outbox: &ReceiptOutbox, receipt_id: &vector<u8>): u64 {
        assert!(table::contains(&outbox.receipts, *receipt_id), EReceiptExists);
        table::borrow(&outbox.receipts, *receipt_id).sequence
    }

    public fun total_committed(outbox: &ReceiptOutbox): u64 {
        outbox.sequence
    }
}
