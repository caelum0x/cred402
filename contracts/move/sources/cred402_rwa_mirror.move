/// Cred402 Move satellite — RWA Mirror.
///
/// Casper holds the canonical RWA evidence registry (Evidence Attestation
/// Envelopes, EAE). This module mirrors the minimal facts a Move satellite needs
/// to price collateral and gate local credit:
///
///   - the Universal Asset ID (UAID): "uaid:<asset_type>:<64-hex blake2b256 digest>"
///   - the Casper-anchored evidence hash and source hash (from the EAE)
///   - an aggregate confidence score in basis points (0..=10000)
///   - the owning agent's CAID
///
/// A UAID is global across chains; the digest is computed on Casper as
/// blake2b256(canonical_json({asset_type, jurisdiction, issuer_hash,
/// document_bundle_hash, salt})). This mirror stores the already-derived UAID and
/// validates its shape: a non-empty asset_type and a 32-byte (64 hex char) digest.
module cred402::cred402_rwa_mirror {
    use std::string::{Self, String};
    use sui::table::{Self, Table};
    use sui::event;

    // ===== Errors =====
    const EUaidPrefix: u64 = 1;
    const EUaidShape: u64 = 2;
    const EBadHashLen: u64 = 3;
    const EConfidenceRange: u64 = 4;
    const EAssetExists: u64 = 5;
    const EAssetMissing: u64 = 6;
    const ENotAdmin: u64 = 7;

    /// Evidence / source hashes are blake2b-256 (32 bytes).
    const HASH_LEN: u64 = 32;
    /// Confidence is basis points.
    const MAX_BPS: u64 = 10000;
    /// b"uaid:"
    const UAID_PREFIX: vector<u8> = b"uaid:";

    public struct RwaMirrorEntry has store, drop, copy {
        uaid: String,
        agent_id: String,            // owner CAID
        evidence_type: String,       // e.g. "invoice", "warehouse_receipt"
        evidence_hash: vector<u8>,   // 32-byte blake2b256, from the EAE
        source_hash: vector<u8>,     // 32-byte blake2b256, from the EAE
        confidence_bps: u64,         // 0..=10000
        mirrored_at_ms: u64,
        active: bool,
    }

    public struct RwaMirror has key {
        id: UID,
        admin: address,
        assets: Table<String, RwaMirrorEntry>,
        count: u64,
    }

    public struct RwaMirrorAdminCap has key, store {
        id: UID,
        mirror: ID,
    }

    public struct RwaMirrored has copy, drop {
        uaid: String,
        agent_id: String,
        confidence_bps: u64,
        mirrored_at_ms: u64,
    }

    public struct RwaConfidenceUpdated has copy, drop {
        uaid: String,
        confidence_bps: u64,
    }

    public struct RwaStatusChanged has copy, drop {
        uaid: String,
        active: bool,
    }

    public fun init_mirror(ctx: &mut TxContext): RwaMirrorAdminCap {
        let mirror = RwaMirror {
            id: object::new(ctx),
            admin: ctx.sender(),
            assets: table::new<String, RwaMirrorEntry>(ctx),
            count: 0,
        };
        let cap = RwaMirrorAdminCap { id: object::new(ctx), mirror: object::id(&mirror) };
        transfer::share_object(mirror);
        cap
    }

    public entry fun create(ctx: &mut TxContext) {
        let cap = init_mirror(ctx);
        transfer::public_transfer(cap, ctx.sender());
    }

    fun assert_admin(mirror: &RwaMirror, cap: &RwaMirrorAdminCap, ctx: &TxContext) {
        assert!(cap.mirror == object::id(mirror), ENotAdmin);
        assert!(mirror.admin == ctx.sender(), ENotAdmin);
    }

    /// Validate the UAID has the canonical "uaid:" prefix and ends with a 64-char
    /// lowercase-hex digest. Layout: uaid:<asset_type>:<64 hex>.
    fun assert_valid_uaid(uaid: &String) {
        let bytes = string::as_bytes(uaid);
        let n = vector::length(bytes);
        let prefix = UAID_PREFIX;
        let plen = vector::length(&prefix);
        // prefix + at least 1 asset_type byte + ":" + 64 hex
        assert!(n > plen + 1 + 1 + 64, EUaidShape);
        let mut i = 0;
        while (i < plen) {
            assert!(*vector::borrow(bytes, i) == *vector::borrow(&prefix, i), EUaidPrefix);
            i = i + 1;
        };
        // The final 64 bytes must be lowercase hex, preceded by ':'.
        let sep_idx = n - 64 - 1;
        assert!(*vector::borrow(bytes, sep_idx) == 58u8, EUaidShape); // ':'
        let mut j = n - 64;
        while (j < n) {
            let c = *vector::borrow(bytes, j);
            let is_digit = c >= 48u8 && c <= 57u8;      // 0-9
            let is_lower = c >= 97u8 && c <= 102u8;     // a-f
            assert!(is_digit || is_lower, EUaidShape);
            j = j + 1;
        };
    }

    public fun mirror_asset(
        mirror: &mut RwaMirror,
        cap: &RwaMirrorAdminCap,
        uaid: String,
        agent_id: String,
        evidence_type: String,
        evidence_hash: vector<u8>,
        source_hash: vector<u8>,
        confidence_bps: u64,
        now_ms: u64,
        ctx: &TxContext,
    ) {
        assert_admin(mirror, cap, ctx);
        assert_valid_uaid(&uaid);
        assert!(vector::length(&evidence_hash) == HASH_LEN, EBadHashLen);
        assert!(vector::length(&source_hash) == HASH_LEN, EBadHashLen);
        assert!(confidence_bps <= MAX_BPS, EConfidenceRange);
        assert!(!table::contains(&mirror.assets, uaid), EAssetExists);

        let entry = RwaMirrorEntry {
            uaid,
            agent_id,
            evidence_type,
            evidence_hash,
            source_hash,
            confidence_bps,
            mirrored_at_ms: now_ms,
            active: true,
        };
        table::add(&mut mirror.assets, uaid, entry);
        mirror.count = mirror.count + 1;

        event::emit(RwaMirrored { uaid, agent_id, confidence_bps, mirrored_at_ms: now_ms });
    }

    public fun update_confidence(
        mirror: &mut RwaMirror,
        cap: &RwaMirrorAdminCap,
        uaid: String,
        confidence_bps: u64,
        ctx: &TxContext,
    ) {
        assert_admin(mirror, cap, ctx);
        assert!(confidence_bps <= MAX_BPS, EConfidenceRange);
        assert!(table::contains(&mirror.assets, uaid), EAssetMissing);
        let e = table::borrow_mut(&mut mirror.assets, uaid);
        e.confidence_bps = confidence_bps;
        event::emit(RwaConfidenceUpdated { uaid, confidence_bps });
    }

    public fun set_active(
        mirror: &mut RwaMirror,
        cap: &RwaMirrorAdminCap,
        uaid: String,
        active: bool,
        ctx: &TxContext,
    ) {
        assert_admin(mirror, cap, ctx);
        assert!(table::contains(&mirror.assets, uaid), EAssetMissing);
        let e = table::borrow_mut(&mut mirror.assets, uaid);
        e.active = active;
        event::emit(RwaStatusChanged { uaid, active });
    }

    // ===== Views =====

    public fun is_mirrored(mirror: &RwaMirror, uaid: &String): bool {
        table::contains(&mirror.assets, *uaid)
    }

    public fun confidence_bps(mirror: &RwaMirror, uaid: &String): u64 {
        assert!(table::contains(&mirror.assets, *uaid), EAssetMissing);
        table::borrow(&mirror.assets, *uaid).confidence_bps
    }

    public fun is_active(mirror: &RwaMirror, uaid: &String): bool {
        if (!table::contains(&mirror.assets, *uaid)) { return false };
        table::borrow(&mirror.assets, *uaid).active
    }

    public fun owner(mirror: &RwaMirror, uaid: &String): String {
        assert!(table::contains(&mirror.assets, *uaid), EAssetMissing);
        table::borrow(&mirror.assets, *uaid).agent_id
    }

    public fun count(mirror: &RwaMirror): u64 {
        mirror.count
    }
}
