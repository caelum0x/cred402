//! spend_key — issues the real NEAR primitive this whole hackathon entry is
//! built on: a Function Call Access Key whose `allowance` is set from the
//! policy's `credit_line`, so nearcore itself — not application code — is
//! what refuses to let an agent overspend.
//!
//! ## Why the spending key lives on THIS contract's own account, not the
//! agent's identity sub-account
//!
//! The plan this module implements originally called for minting the key
//! directly on a brand-new `agent-<id>.<spendguard>.testnet` sub-account.
//! That is exactly right for *issuing* the key: NEAR allows `CreateAccount`
//! together with `AddKey` in the SAME action batch/receipt, because at that
//! instant the creating contract is the new account's only authority.
//!
//! It breaks down for Day 6's *revocation* step. Once a sub-account exists
//! independently, NEAR's runtime only allows `AddKey` / `DeleteKey` /
//! `DeployContract` / `Stake` / `DeleteAccount` actions against an account
//! when `predecessor_id == receiver_id` for that action's receipt — i.e. an
//! account managing *itself* (the standard "self-upgrade" / "self-destruct"
//! pattern every NEAR contract uses). A parent contract has no standing
//! authority to reach back into a sub-account it created earlier and delete
//! a key on it; that would be a account-takeover primitive NEAR deliberately
//! does not expose. (The only legitimate way to get that back is to deploy a
//! second, self-revoking contract to every sub-account — real, but a second
//! wasm binary this pass's time budget goes to the exposure/policy/demo path
//! instead; noted as a Day-7+ follow-up.)
//!
//! So this module splits identity from enforcement:
//! - `identity_subaccount_id` / the sub-account created by `lib.rs` is the
//!   agent's human-readable, funded, on-chain identity — "the sandboxed
//!   wallet" in the demo narrative.
//! - The actual capped, revocable spending permission is a Function Call
//!   Access Key added to `env::current_account_id()` (this contract),
//!   scoped to call only `spend_to_seller` on itself. Minting and revoking
//!   it are both same-account self-actions, which NEAR always permits, so
//!   Day 6's "delete the key, the next call hard-fails at the protocol
//!   layer" demo is 100% real instead of relying on an app-level `assert!`.

use near_sdk::{env, AccountId, Allowance, NearToken, Promise, PublicKey};

/// Funds the agent's identity sub-account with just enough NEAR to exist
/// (NEAR's storage staking minimum for a bare account is a small fraction of
/// this). It never holds spendable credit — that stays pooled on the
/// contract account and is metered per-agent by the Function Call key's
/// allowance plus `ExposureBook`.
pub const IDENTITY_SUBACCOUNT_DEPOSIT: NearToken = NearToken::from_millinear(10); // 0.01 NEAR

/// The only method an agent's spend key is ever allowed to call.
pub const SPEND_METHOD: &str = "spend_to_seller";

/// Derive the deterministic sub-account id for an agent under this
/// contract's own account (`agent-<id>.<this-contract>`), lowercased and
/// with any character NEAR account ids disallow mapped to `-`.
pub fn identity_subaccount_id(agent_id: &str) -> AccountId {
    let safe: String = agent_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let candidate = format!("agent-{}.{}", safe, env::current_account_id());
    candidate
        .parse()
        .unwrap_or_else(|_| env::panic_str("derived agent sub-account id is not a valid NEAR account id"))
}

/// Create + fund the agent's identity sub-account. Pure bookkeeping/branding
/// (see module docs) — never the account the spend key is scoped to.
pub fn create_identity_subaccount(sub_account: AccountId) -> Promise {
    Promise::new(sub_account).create_account().transfer(IDENTITY_SUBACCOUNT_DEPOSIT)
}

/// Mint the real spending permission: a Function Call Access Key on this
/// contract's own account, allowance = `credit_line_yocto`, scoped to only
/// ever call `spend_to_seller` on this same contract. This — not app code —
/// is what makes the cap physically unexceedable.
pub fn mint_spend_key(public_key: PublicKey, credit_line_yocto: u128) -> Promise {
    let allowance = Allowance::limited(NearToken::from_yoctonear(credit_line_yocto))
        .unwrap_or_else(|| env::panic_str("credit_line must be greater than zero to mint a spend key"));
    Promise::new(env::current_account_id()).add_access_key_allowance(
        public_key,
        allowance,
        env::current_account_id(),
        SPEND_METHOD.to_string(),
    )
}

/// The circuit breaker: delete the spend key from this contract's own
/// account. A same-account self-action, so nearcore accepts it outside any
/// account-creation batch — and once it lands, any further transaction
/// signed with that key is rejected by nearcore at the access-key
/// validation step, before this contract's code ever runs again.
pub fn revoke_spend_key(public_key: PublicKey) -> Promise {
    Promise::new(env::current_account_id()).delete_key(public_key)
}

/// Re-mint (replace) an agent's EXISTING, still-active spend key with a new
/// allowance — what `SpendGuard::top_up_allowance` calls after
/// `ExposureBook::reserve_exposure` restores headroom a repayment freed.
///
/// A real NEAR protocol constraint discovered while building this and
/// confirmed live against a running local nearcore node (`tests/sandbox.rs`):
/// unlike a brand-new key, `AddKey` for a public key that ALREADY EXISTS on
/// the account is unconditionally rejected —
/// `ActionError::AddKeyAlreadyExists` — there is no "update an access key's
/// allowance" action in the NEAR protocol. So topping up means delete-then-
/// readd, not add-again. Both actions target this same contract account in
/// the SAME receipt (same-account self-actions, which nearcore always
/// permits to run in order within one receipt — see the module docs above
/// on why the spend key lives on this contract's own account at all), so
/// the key is never actually missing from any OTHER transaction's point of
/// view: nearcore applies both actions atomically within this one receipt
/// before any other transaction signed by that key could be included in a
/// later block.
pub fn retop_spend_key(public_key: PublicKey, new_allowance_yocto: u128) -> Promise {
    let allowance = Allowance::limited(NearToken::from_yoctonear(new_allowance_yocto))
        .unwrap_or_else(|| env::panic_str("top-up allowance must be greater than zero"));
    Promise::new(env::current_account_id())
        .delete_key(public_key.clone())
        .add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            SPEND_METHOD.to_string(),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    fn set_current(account: &str) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id(account.parse().unwrap());
        testing_env!(ctx.build());
        let _ = get_logs(); // drain, avoid unused-import warnings under some feature sets
    }

    #[test]
    fn identity_subaccount_id_is_deterministic_and_lowercased() {
        set_current("spendguard.testnet");
        let a = identity_subaccount_id("Agent_42");
        let b = identity_subaccount_id("Agent_42");
        assert_eq!(a, b);
        assert_eq!(a.to_string(), "agent-agent-42.spendguard.testnet");
    }

    #[test]
    #[should_panic(expected = "credit_line must be greater than zero")]
    fn mint_spend_key_rejects_a_zero_allowance() {
        set_current("spendguard.testnet");
        let pk: PublicKey = "ed25519:8qnA1LSJMnGYoUdHoTQ1SBayJQYJvhzvT4tdF8RVLTPG".parse().unwrap();
        let _ = mint_spend_key(pk, 0);
    }
}
