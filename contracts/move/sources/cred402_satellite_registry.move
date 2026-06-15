/// Cred402 Move satellite — Satellite Registry (local agent passports).
///
/// Casper is the canonical identity root. This module keeps a thin, local mirror
/// of agent passports on the Move satellite so that vaults, outboxes and RWA
/// mirrors can resolve an agent's CAID and bound Move address without a cross-chain
/// call on every operation.
///
/// A passport here is NEVER authoritative for credit policy — it only records:
///   - the canonical Casper-rooted CAID  ("cred402:casper:<agent_id>")
///   - the Casper ed25519 account public key bytes (32 bytes, used to verify
///     agent-signed satellite messages)
///   - the bound Move address (the satellite-side execution account)
///
/// The binding itself is rooted by a Casper-signed Address Binding Envelope (ABE)
/// on the Casper layer; this registry stores the resolved, already-verified result.
module cred402::cred402_satellite_registry {
    use std::string::{Self, String};
    use sui::table::{Self, Table};
    use sui::event;

    // ===== Errors =====
    const ECaidEmpty: u64 = 1;
    const EBadCasperKeyLen: u64 = 2;
    const EAgentExists: u64 = 3;
    const EAgentMissing: u64 = 4;
    const ENotAdmin: u64 = 5;
    const ECaidPrefix: u64 = 6;

    /// Casper ed25519 public keys are 32 raw bytes.
    const CASPER_PUBKEY_LEN: u64 = 32;

    /// Canonical CAID prefix — every agent is rooted on Casper.
    /// b"cred402:casper:"
    const CAID_PREFIX: vector<u8> = b"cred402:casper:";

    /// One local passport mirror for a Casper-rooted agent.
    public struct AgentPassport has store, drop, copy {
        caid: String,
        casper_pubkey: vector<u8>,
        move_address: address,
        registered_at_ms: u64,
        active: bool,
    }

    /// Shared registry object. `admin` is the satellite operator (the relayer that
    /// publishes Casper-verified passports onto this chain).
    public struct SatelliteRegistry has key {
        id: UID,
        admin: address,
        passports: Table<String, AgentPassport>,
        count: u64,
    }

    /// Capability proving the holder may administer the registry.
    public struct RegistryAdminCap has key, store {
        id: UID,
        registry: ID,
    }

    // ===== Events =====
    public struct PassportRegistered has copy, drop {
        caid: String,
        move_address: address,
        registered_at_ms: u64,
    }

    public struct PassportStatusChanged has copy, drop {
        caid: String,
        active: bool,
    }

    /// Create a fresh satellite registry. The publisher becomes the admin and
    /// receives the admin capability.
    public fun init_registry(ctx: &mut TxContext): RegistryAdminCap {
        let registry = SatelliteRegistry {
            id: object::new(ctx),
            admin: ctx.sender(),
            passports: table::new<String, AgentPassport>(ctx),
            count: 0,
        };
        let cap = RegistryAdminCap {
            id: object::new(ctx),
            registry: object::id(&registry),
        };
        transfer::share_object(registry);
        cap
    }

    /// Entry wrapper: create + share registry, transfer cap to sender.
    public entry fun create(ctx: &mut TxContext) {
        let cap = init_registry(ctx);
        transfer::public_transfer(cap, ctx.sender());
    }

    fun assert_admin(reg: &SatelliteRegistry, cap: &RegistryAdminCap, ctx: &TxContext) {
        assert!(cap.registry == object::id(reg), ENotAdmin);
        assert!(reg.admin == ctx.sender(), ENotAdmin);
    }

    /// Validate the CAID is non-empty and carries the canonical Casper root prefix.
    fun assert_valid_caid(caid: &String) {
        let bytes = string::as_bytes(caid);
        assert!(vector::length(bytes) > 0, ECaidEmpty);
        let prefix = CAID_PREFIX;
        let plen = vector::length(&prefix);
        assert!(vector::length(bytes) > plen, ECaidPrefix);
        let mut i = 0;
        while (i < plen) {
            assert!(*vector::borrow(bytes, i) == *vector::borrow(&prefix, i), ECaidPrefix);
            i = i + 1;
        };
    }

    /// Register a Casper-verified passport on the satellite.
    ///
    /// `caid` MUST equal "cred402:casper:<agent_id>". `casper_pubkey` MUST be the
    /// 32-byte ed25519 public key whose corresponding key signed the agent's
    /// Casper-rooted bindings.
    public fun register_passport(
        reg: &mut SatelliteRegistry,
        cap: &RegistryAdminCap,
        caid: String,
        casper_pubkey: vector<u8>,
        move_address: address,
        now_ms: u64,
        ctx: &TxContext,
    ) {
        assert_admin(reg, cap, ctx);
        assert_valid_caid(&caid);
        assert!(vector::length(&casper_pubkey) == CASPER_PUBKEY_LEN, EBadCasperKeyLen);
        assert!(!table::contains(&reg.passports, caid), EAgentExists);

        let passport = AgentPassport {
            caid,
            casper_pubkey,
            move_address,
            registered_at_ms: now_ms,
            active: true,
        };
        table::add(&mut reg.passports, caid, passport);
        reg.count = reg.count + 1;

        event::emit(PassportRegistered { caid, move_address, registered_at_ms: now_ms });
    }

    /// Activate / deactivate a local passport (e.g. mirror a Casper-side suspension).
    public fun set_active(
        reg: &mut SatelliteRegistry,
        cap: &RegistryAdminCap,
        caid: String,
        active: bool,
        ctx: &TxContext,
    ) {
        assert_admin(reg, cap, ctx);
        assert!(table::contains(&reg.passports, caid), EAgentMissing);
        let p = table::borrow_mut(&mut reg.passports, caid);
        p.active = active;
        event::emit(PassportStatusChanged { caid, active });
    }

    // ===== Read-only views =====

    public fun is_registered(reg: &SatelliteRegistry, caid: &String): bool {
        table::contains(&reg.passports, *caid)
    }

    public fun is_active(reg: &SatelliteRegistry, caid: &String): bool {
        if (!table::contains(&reg.passports, *caid)) { return false };
        table::borrow(&reg.passports, *caid).active
    }

    /// Return the 32-byte Casper ed25519 pubkey for an agent (aborts if missing).
    public fun casper_pubkey(reg: &SatelliteRegistry, caid: &String): vector<u8> {
        assert!(table::contains(&reg.passports, *caid), EAgentMissing);
        table::borrow(&reg.passports, *caid).casper_pubkey
    }

    public fun move_address(reg: &SatelliteRegistry, caid: &String): address {
        assert!(table::contains(&reg.passports, *caid), EAgentMissing);
        table::borrow(&reg.passports, *caid).move_address
    }

    public fun count(reg: &SatelliteRegistry): u64 {
        reg.count
    }

    public fun admin(reg: &SatelliteRegistry): address {
        reg.admin
    }
}
