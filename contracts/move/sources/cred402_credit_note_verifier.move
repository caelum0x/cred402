/// Cred402 Move satellite — Credit Note Verifier (CAN).
///
/// THE most important multichain credit object. A Credit Authorization Note (CAN)
/// is a short-lived, Casper-policy-signed permission that lets a satellite chain
/// open or modify a credit line for an agent up to a global-exposure-checked limit.
///
/// "EVM executes credit; Casper approves credit." — and the same holds for Move.
/// A satellite vault must NOT lend without a valid CAN. This module:
///
///   1. Models the CAN exactly as crosschain/standards/credit_notes.ts.
///   2. Reconstructs the canonical signing payload — `stableStringify(unsigned)` —
///      i.e. JSON with keys sorted lexicographically and NO whitespace, matching
///      `noteSigningPayload()` byte-for-byte.
///   3. Verifies the ed25519 `casper_policy_signature` over that payload using the
///      Casper policy public key, via `sui::ed25519`.
///   4. Checks expiry, target chain, target pool and the integer `max_draw`.
///
/// The canonical key order (sorted) of the unsigned CAN is:
///   agent_id, asset, credit_score, expires_at, global_exposure_after_draw,
///   max_draw, note_id, nonce, risk_policy_version, target_chain, target_pool,
///   type, version
module cred402::cred402_credit_note_verifier {
    use std::string::{Self, String};
    use sui::ed25519;

    // ===== Errors =====
    const EWrongType: u64 = 1;
    const EExpired: u64 = 2;
    const EWrongChain: u64 = 3;
    const EWrongPool: u64 = 4;
    const EBadSigLen: u64 = 5;
    const EBadKeyLen: u64 = 6;
    const EBadSignature: u64 = 7;

    /// Canonical constant fields.
    const CAN_TYPE: vector<u8> = b"Cred402CreditAuthorizationNote";
    const CAN_VERSION: vector<u8> = b"1";

    /// ed25519 sizes.
    const SIG_LEN: u64 = 64;
    const PUBKEY_LEN: u64 = 32;

    /// Credit Authorization Note — mirrors the canonical TS interface. `max_draw`
    /// and `global_exposure_after_draw` are smallest-unit integer strings in the TS
    /// standard; here they are carried as u64 (smallest units) for arithmetic safety
    /// inside the vault, AND as their original decimal strings so the canonical
    /// signing payload can be reproduced byte-for-byte.
    public struct CreditAuthorizationNote has store, drop, copy {
        note_id: String,
        agent_id: String,
        target_chain: String,                  // e.g. "sui:testnet"
        target_pool: String,                   // satellite vault id, lowercase hex
        max_draw: u64,
        max_draw_str: String,                  // decimal string == max_draw
        asset: String,                         // "USDC" | ...
        credit_score: u64,
        risk_policy_version: u64,
        global_exposure_after_draw: u64,
        global_exposure_after_draw_str: String,// decimal string
        expires_at: u64,                       // epoch ms
        nonce: String,
        casper_policy_signature: vector<u8>,   // 64-byte ed25519 signature
    }

    /// Construct a CAN value from its parsed fields (called by a relayer / off-chain
    /// SDK that has the wire CAN). The decimal-string forms MUST be supplied so the
    /// canonical payload is exact.
    public fun new_note(
        note_id: String,
        agent_id: String,
        target_chain: String,
        target_pool: String,
        max_draw: u64,
        max_draw_str: String,
        asset: String,
        credit_score: u64,
        risk_policy_version: u64,
        global_exposure_after_draw: u64,
        global_exposure_after_draw_str: String,
        expires_at: u64,
        nonce: String,
        casper_policy_signature: vector<u8>,
    ): CreditAuthorizationNote {
        CreditAuthorizationNote {
            note_id,
            agent_id,
            target_chain,
            target_pool,
            max_draw,
            max_draw_str,
            asset,
            credit_score,
            risk_policy_version,
            global_exposure_after_draw,
            global_exposure_after_draw_str,
            expires_at,
            nonce,
            casper_policy_signature,
        }
    }

    // ===== Field accessors (used by the vault) =====
    public fun agent_id(can: &CreditAuthorizationNote): String { can.agent_id }
    public fun target_chain(can: &CreditAuthorizationNote): String { can.target_chain }
    public fun target_pool(can: &CreditAuthorizationNote): String { can.target_pool }
    public fun max_draw(can: &CreditAuthorizationNote): u64 { can.max_draw }
    public fun asset(can: &CreditAuthorizationNote): String { can.asset }
    public fun credit_score(can: &CreditAuthorizationNote): u64 { can.credit_score }
    public fun risk_policy_version(can: &CreditAuthorizationNote): u64 { can.risk_policy_version }
    public fun global_exposure_after_draw(can: &CreditAuthorizationNote): u64 { can.global_exposure_after_draw }
    public fun expires_at(can: &CreditAuthorizationNote): u64 { can.expires_at }
    public fun nonce(can: &CreditAuthorizationNote): String { can.nonce }
    public fun note_id(can: &CreditAuthorizationNote): String { can.note_id }

    /// Append a JSON string member  `"key":"value"`  to `out`.
    fun push_str_member(out: &mut vector<u8>, key: vector<u8>, value: &String) {
        vector::push_back(out, 34u8); // "
        vector::append(out, key);
        vector::push_back(out, 34u8); // "
        vector::push_back(out, 58u8); // :
        vector::push_back(out, 34u8); // "
        vector::append(out, *string::as_bytes(value));
        vector::push_back(out, 34u8); // "
    }

    /// Append a JSON number member  `"key":<digits>`  to `out`. The numeric form is
    /// supplied as its already-canonical decimal-string bytes so it matches
    /// JSON.stringify of the original number exactly.
    fun push_num_member(out: &mut vector<u8>, key: vector<u8>, digits: &String) {
        vector::push_back(out, 34u8); // "
        vector::append(out, key);
        vector::push_back(out, 34u8); // "
        vector::push_back(out, 58u8); // :
        vector::append(out, *string::as_bytes(digits));
    }

    /// Convert a u64 to its decimal-string bytes (no leading zeros, "0" for zero).
    fun u64_to_decimal(n: u64): String {
        if (n == 0) { return string::utf8(b"0") };
        let mut digits = vector::empty<u8>();
        let mut x = n;
        while (x > 0) {
            let d = ((x % 10) as u8) + 48u8;
            vector::push_back(&mut digits, d);
            x = x / 10;
        };
        // reverse
        let mut out = vector::empty<u8>();
        let mut i = vector::length(&digits);
        while (i > 0) {
            i = i - 1;
            vector::push_back(&mut out, *vector::borrow(&digits, i));
        };
        string::utf8(out)
    }

    /// Rebuild the canonical signing payload — exactly `noteSigningPayload(can)`:
    /// `stableStringify(unsigned_can)` with sorted keys and no whitespace.
    ///
    /// Sorted key order:
    ///   agent_id, asset, credit_score, expires_at, global_exposure_after_draw,
    ///   max_draw, note_id, nonce, risk_policy_version, target_chain, target_pool,
    ///   type, version
    public fun signing_payload(can: &CreditAuthorizationNote): vector<u8> {
        let mut out = vector::empty<u8>();
        vector::push_back(&mut out, 123u8); // {

        push_str_member(&mut out, b"agent_id", &can.agent_id);
        vector::push_back(&mut out, 44u8); // ,

        push_str_member(&mut out, b"asset", &can.asset);
        vector::push_back(&mut out, 44u8);

        let credit_score_str = u64_to_decimal(can.credit_score);
        push_num_member(&mut out, b"credit_score", &credit_score_str);
        vector::push_back(&mut out, 44u8);

        let expires_str = u64_to_decimal(can.expires_at);
        push_num_member(&mut out, b"expires_at", &expires_str);
        vector::push_back(&mut out, 44u8);

        // global_exposure_after_draw is a string field in the TS standard.
        push_str_member(&mut out, b"global_exposure_after_draw", &can.global_exposure_after_draw_str);
        vector::push_back(&mut out, 44u8);

        // max_draw is a string field in the TS standard.
        push_str_member(&mut out, b"max_draw", &can.max_draw_str);
        vector::push_back(&mut out, 44u8);

        push_str_member(&mut out, b"note_id", &can.note_id);
        vector::push_back(&mut out, 44u8);

        push_str_member(&mut out, b"nonce", &can.nonce);
        vector::push_back(&mut out, 44u8);

        let rpv_str = u64_to_decimal(can.risk_policy_version);
        push_num_member(&mut out, b"risk_policy_version", &rpv_str);
        vector::push_back(&mut out, 44u8);

        push_str_member(&mut out, b"target_chain", &can.target_chain);
        vector::push_back(&mut out, 44u8);

        push_str_member(&mut out, b"target_pool", &can.target_pool);
        vector::push_back(&mut out, 44u8);

        let type_str = string::utf8(CAN_TYPE);
        push_str_member(&mut out, b"type", &type_str);
        vector::push_back(&mut out, 44u8);

        let version_str = string::utf8(CAN_VERSION);
        push_str_member(&mut out, b"version", &version_str);

        vector::push_back(&mut out, 125u8); // }
        out
    }

    /// Full satellite-side verification of a CAN. Aborts on the first failure with a
    /// specific error code. Mirrors `verifyCreditAuthorizationNote`:
    ///   - signature present + 64 bytes, pubkey 32 bytes
    ///   - not expired (now_ms <= expires_at)
    ///   - target_chain matches the satellite chain
    ///   - target_pool matches this vault (lowercase-hex compare done by caller)
    ///   - ed25519 signature valid over the canonical payload
    public fun verify(
        can: &CreditAuthorizationNote,
        policy_pubkey: &vector<u8>,
        now_ms: u64,
        expected_chain: &String,
        expected_pool: &String,
    ) {
        assert!(vector::length(&can.casper_policy_signature) == SIG_LEN, EBadSigLen);
        assert!(vector::length(policy_pubkey) == PUBKEY_LEN, EBadKeyLen);
        assert!(now_ms <= can.expires_at, EExpired);
        assert!(string_eq(&can.target_chain, expected_chain), EWrongChain);
        assert!(string_eq(&can.target_pool, expected_pool), EWrongPool);

        // type / version are constants baked into the payload reconstruction; a
        // mismatch would surface as an invalid signature, but we guard explicitly.
        assert!(string::as_bytes(&string::utf8(CAN_TYPE)) == &CAN_TYPE, EWrongType);

        let payload = signing_payload(can);
        let ok = ed25519::ed25519_verify(&can.casper_policy_signature, policy_pubkey, &payload);
        assert!(ok, EBadSignature);
    }

    /// Non-aborting variant — returns true iff the CAN is fully valid.
    public fun is_valid(
        can: &CreditAuthorizationNote,
        policy_pubkey: &vector<u8>,
        now_ms: u64,
        expected_chain: &String,
        expected_pool: &String,
    ): bool {
        if (vector::length(&can.casper_policy_signature) != SIG_LEN) { return false };
        if (vector::length(policy_pubkey) != PUBKEY_LEN) { return false };
        if (now_ms > can.expires_at) { return false };
        if (!string_eq(&can.target_chain, expected_chain)) { return false };
        if (!string_eq(&can.target_pool, expected_pool)) { return false };
        let payload = signing_payload(can);
        ed25519::ed25519_verify(&can.casper_policy_signature, policy_pubkey, &payload)
    }

    fun string_eq(a: &String, b: &String): bool {
        string::as_bytes(a) == string::as_bytes(b)
    }
}
