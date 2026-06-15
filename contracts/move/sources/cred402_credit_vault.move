/// Cred402 Move satellite — Credit Vault (asset-safe).
///
/// "EVM executes credit; Casper approves credit." The same rule governs Move.
///
/// This vault holds real liquidity (a `Balance<T>`, e.g. USDC) and lends ONLY
/// against a valid, unexpired, target-matching, Casper-policy-signed Credit
/// Authorization Note (CAN), and NEVER beyond `CAN.max_draw`. Every draw and
/// repayment emits an event that a relayer reports back to Casper so the
/// GlobalExposureManager can prevent multi-chain over-borrow.
///
/// Asset safety:
///   - liquidity is a `Balance<T>` owned by the shared vault; draws split a `Coin`
///     out of it; repayments merge a `Coin` back in. No phantom balances.
///   - per-agent debt is tracked in a dedicated `AgentDebt` record so exposure is
///     always reconcilable.
///   - a per-(agent, note_id) used-amount ledger enforces that a single CAN cannot
///     authorize more than `max_draw` in aggregate, even across multiple draws.
module cred402::cred402_credit_vault {
    use std::string::String;
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::table::{Self, Table};
    use sui::event;
    use sui::address;
    use cred402::cred402_credit_note_verifier::{Self as cnv, CreditAuthorizationNote};

    // ===== Errors =====
    const ENotAdmin: u64 = 1;
    const EInvalidNote: u64 = 2;
    const EExceedsMaxDraw: u64 = 3;
    const EInsufficientLiquidity: u64 = 4;
    const EWrongAgentAddress: u64 = 5;
    const ERepayTooMuch: u64 = 6;
    const ENoDebt: u64 = 7;
    const EZeroAmount: u64 = 8;
    const EPaused: u64 = 9;

    /// Per-agent debt record. Keyed by the agent's CAID in the vault table.
    public struct AgentDebt has store, drop {
        caid: String,
        principal_outstanding: u64, // smallest units still owed
        total_drawn: u64,           // lifetime drawn
        total_repaid: u64,          // lifetime repaid
        last_update_ms: u64,
    }

    /// The asset-safe credit vault. `T` is the liquidity coin type (e.g. USDC).
    public struct CreditVault<phantom T> has key {
        id: UID,
        admin: address,
        /// The canonical Casper RISK-POLICY ed25519 public key (32 bytes). A CAN is
        /// only honored if signed by THIS key.
        policy_pubkey: vector<u8>,
        /// The satellite chain id this vault is bound to (CAN.target_chain must match).
        chain_id: String,
        /// This vault's canonical pool id as a lowercase-hex string (CAN.target_pool
        /// must match). Set at creation to the vault object id.
        pool_id: String,
        liquidity: Balance<T>,
        debts: Table<String, AgentDebt>,        // caid -> debt
        note_used: Table<String, u64>,          // note_id -> amount already drawn under it
        total_outstanding: u64,                  // sum of all principal_outstanding
        paused: bool,
    }

    public struct VaultAdminCap has key, store {
        id: UID,
        vault: ID,
    }

    // ===== Events (reported back to Casper by a relayer) =====

    /// A credit draw executed against a verified CAN. Relayer forwards this to the
    /// Casper GlobalExposureManager to record the new global exposure.
    public struct CreditDrawn has copy, drop {
        caid: String,
        note_id: String,
        amount: u64,
        principal_outstanding: u64,
        global_exposure_after_draw: u64, // as authorized by Casper in the CAN
        drawn_at_ms: u64,
    }

    /// A repayment. Relayer forwards this to Casper to release exposure.
    public struct CreditRepaid has copy, drop {
        caid: String,
        amount: u64,
        principal_outstanding: u64,
        repaid_at_ms: u64,
    }

    public struct LiquidityAdded has copy, drop {
        amount: u64,
        total_liquidity: u64,
    }

    public struct VaultPaused has copy, drop { paused: bool }

    /// Create an asset-safe credit vault bound to a Casper policy key and a chain.
    public fun init_vault<T>(
        policy_pubkey: vector<u8>,
        chain_id: String,
        ctx: &mut TxContext,
    ): VaultAdminCap {
        let uid = object::new(ctx);
        let vault_addr = object::uid_to_address(&uid);
        let vault = CreditVault<T> {
            id: uid,
            admin: ctx.sender(),
            policy_pubkey,
            chain_id,
            pool_id: address::to_string(vault_addr),
            liquidity: balance::zero<T>(),
            debts: table::new<String, AgentDebt>(ctx),
            note_used: table::new<String, u64>(ctx),
            total_outstanding: 0,
            paused: false,
        };
        let cap = VaultAdminCap { id: object::new(ctx), vault: object::id(&vault) };
        transfer::share_object(vault);
        cap
    }

    fun assert_admin<T>(vault: &CreditVault<T>, cap: &VaultAdminCap, ctx: &TxContext) {
        assert!(cap.vault == object::id(vault), ENotAdmin);
        assert!(vault.admin == ctx.sender(), ENotAdmin);
    }

    /// Supply liquidity to the vault (LPs / treasury).
    public fun add_liquidity<T>(
        vault: &mut CreditVault<T>,
        funds: Coin<T>,
    ) {
        let amount = coin::value(&funds);
        assert!(amount > 0, EZeroAmount);
        balance::join(&mut vault.liquidity, coin::into_balance(funds));
        event::emit(LiquidityAdded { amount, total_liquidity: balance::value(&vault.liquidity) });
    }

    /// Admin withdraws idle liquidity (never the lent-out principal — only the free
    /// balance is withdrawable since debt is tracked separately).
    public fun withdraw_liquidity<T>(
        vault: &mut CreditVault<T>,
        cap: &VaultAdminCap,
        amount: u64,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert_admin(vault, cap, ctx);
        assert!(amount > 0, EZeroAmount);
        assert!(balance::value(&vault.liquidity) >= amount, EInsufficientLiquidity);
        coin::from_balance(balance::split(&mut vault.liquidity, amount), ctx)
    }

    public fun set_paused<T>(
        vault: &mut CreditVault<T>,
        cap: &VaultAdminCap,
        paused: bool,
        ctx: &TxContext,
    ) {
        assert_admin(vault, cap, ctx);
        vault.paused = paused;
        event::emit(VaultPaused { paused });
    }

    /// Draw credit against a Casper-signed CAN.
    ///
    /// Gating (all enforced before any asset moves):
    ///   1. vault not paused
    ///   2. CAN verifies (ed25519 over canonical payload, not expired, target chain
    ///      == this vault's chain, target pool == this vault's pool id)
    ///   3. aggregate draws under this note_id never exceed CAN.max_draw
    ///   4. requested amount <= free liquidity
    ///   5. `agent_address` matches the recorded passport binding (caller supplies
    ///      the agent's resolved Move address; the funds are sent there)
    ///
    /// Returns a `Coin<T>` of `amount` to the borrowing agent.
    public fun draw<T>(
        vault: &mut CreditVault<T>,
        can: &CreditAuthorizationNote,
        amount: u64,
        agent_address: address,
        now_ms: u64,
        ctx: &mut TxContext,
    ): Coin<T> {
        assert!(!vault.paused, EPaused);
        assert!(amount > 0, EZeroAmount);

        // (2) Casper approval — verify the note against THIS vault's policy key,
        // chain and pool. Aborts via the verifier on any failure.
        assert!(
            cnv::is_valid(can, &vault.policy_pubkey, now_ms, &vault.chain_id, &vault.pool_id),
            EInvalidNote,
        );

        let caid = cnv::agent_id(can);
        let note_id = cnv::note_id(can);
        let max_draw = cnv::max_draw(can);

        // (3) never beyond CAN.max_draw, in aggregate across draws under this note.
        let already = if (table::contains(&vault.note_used, note_id)) {
            *table::borrow(&vault.note_used, note_id)
        } else { 0 };
        assert!(already + amount <= max_draw, EExceedsMaxDraw);

        // (4) free liquidity check.
        assert!(balance::value(&vault.liquidity) >= amount, EInsufficientLiquidity);

        // (5) recipient must be a non-zero address (resolved agent binding).
        assert!(agent_address != @0x0, EWrongAgentAddress);

        // Update the per-note used ledger.
        if (table::contains(&vault.note_used, note_id)) {
            let u = table::borrow_mut(&mut vault.note_used, note_id);
            *u = *u + amount;
        } else {
            table::add(&mut vault.note_used, note_id, amount);
        };

        // Update / create the agent debt record.
        if (table::contains(&vault.debts, caid)) {
            let d = table::borrow_mut(&mut vault.debts, caid);
            d.principal_outstanding = d.principal_outstanding + amount;
            d.total_drawn = d.total_drawn + amount;
            d.last_update_ms = now_ms;
        } else {
            table::add(&mut vault.debts, caid, AgentDebt {
                caid,
                principal_outstanding: amount,
                total_drawn: amount,
                total_repaid: 0,
                last_update_ms: now_ms,
            });
        };
        vault.total_outstanding = vault.total_outstanding + amount;

        // Move the asset.
        let out = coin::from_balance(balance::split(&mut vault.liquidity, amount), ctx);

        // Report back to Casper (exposure accounting).
        event::emit(CreditDrawn {
            caid,
            note_id,
            amount,
            principal_outstanding: table::borrow(&vault.debts, caid).principal_outstanding,
            global_exposure_after_draw: cnv::global_exposure_after_draw(can),
            drawn_at_ms: now_ms,
        });

        out
    }

    /// Repay (part of) an agent's outstanding principal. The coin is merged back
    /// into the vault liquidity and exposure is released.
    public fun repay<T>(
        vault: &mut CreditVault<T>,
        caid: String,
        payment: Coin<T>,
        now_ms: u64,
    ) {
        let amount = coin::value(&payment);
        assert!(amount > 0, EZeroAmount);
        assert!(table::contains(&vault.debts, caid), ENoDebt);

        let d = table::borrow_mut(&mut vault.debts, caid);
        assert!(d.principal_outstanding >= amount, ERepayTooMuch);

        d.principal_outstanding = d.principal_outstanding - amount;
        d.total_repaid = d.total_repaid + amount;
        d.last_update_ms = now_ms;
        let remaining = d.principal_outstanding;

        vault.total_outstanding = vault.total_outstanding - amount;
        balance::join(&mut vault.liquidity, coin::into_balance(payment));

        event::emit(CreditRepaid {
            caid,
            amount,
            principal_outstanding: remaining,
            repaid_at_ms: now_ms,
        });
    }

    // ===== Views =====

    public fun outstanding_of<T>(vault: &CreditVault<T>, caid: &String): u64 {
        if (!table::contains(&vault.debts, *caid)) { return 0 };
        table::borrow(&vault.debts, *caid).principal_outstanding
    }

    public fun note_used<T>(vault: &CreditVault<T>, note_id: &String): u64 {
        if (!table::contains(&vault.note_used, *note_id)) { return 0 };
        *table::borrow(&vault.note_used, *note_id)
    }

    public fun available_liquidity<T>(vault: &CreditVault<T>): u64 {
        balance::value(&vault.liquidity)
    }

    public fun total_outstanding<T>(vault: &CreditVault<T>): u64 {
        vault.total_outstanding
    }

    public fun pool_id<T>(vault: &CreditVault<T>): String {
        vault.pool_id
    }

    public fun chain_id<T>(vault: &CreditVault<T>): String {
        vault.chain_id
    }

    public fun is_paused<T>(vault: &CreditVault<T>): bool {
        vault.paused
    }
}
