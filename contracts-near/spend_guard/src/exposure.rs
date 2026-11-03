//! ExposureBook — new Rust, ported from the existing TypeScript
//! `lib/ledger/contracts/global_exposure_manager.ts` (`GlobalExposureManager`).
//! No Casper/Odra crate exists for this contract today (checked: `contracts/`
//! has no `global_exposure_manager` directory), so this is a fresh port, not
//! a syntax translation of existing Rust.
//!
//! Tracks each agent's TOTAL credit exposure (NOT just what SpendGuard itself
//! has issued) so an agent can never be authorized beyond its global cap —
//! the same "killer multichain failure mode" guard the TS contract documents,
//! now enforced on NEAR before a Function Call Access Key is ever minted.
//! Amounts are yoctoNEAR (u128), matching `policy.rs`.

use near_sdk::json_types::U128;
use near_sdk::near;
use near_sdk::store::LookupMap;
use near_sdk::{env, IntoStorageKey};

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentExposure {
    pub agent_id: String,
    pub outstanding: U128,
    pub reserved: U128,
    pub max_allowed: U128,
    pub frozen: bool,
    pub updated_at: u64,
}

#[near(serializers=[borsh])]
pub struct ExposureBook {
    exposure: LookupMap<String, AgentExposure>,
}

impl ExposureBook {
    pub fn new<S>(prefix: S) -> Self
    where
        S: IntoStorageKey,
    {
        Self { exposure: LookupMap::new(prefix) }
    }

    /// Create the agent's exposure record if missing; raise (never silently
    /// lower) `max_allowed` if the policy now permits more — mirrors the TS
    /// `ensure_agent`.
    pub fn ensure_agent(&mut self, agent_id: &str, max_allowed: u128) -> AgentExposure {
        if let Some(existing) = self.exposure.get(agent_id) {
            let mut updated = existing.clone();
            if max_allowed > updated.max_allowed.0 {
                updated.max_allowed = U128(max_allowed);
                updated.updated_at = env::block_timestamp();
                self.exposure.insert(agent_id.to_string(), updated.clone());
            }
            return updated;
        }
        let record = AgentExposure {
            agent_id: agent_id.to_string(),
            outstanding: U128(0),
            reserved: U128(0),
            max_allowed: U128(max_allowed),
            frozen: false,
            updated_at: env::block_timestamp(),
        };
        self.exposure.insert(agent_id.to_string(), record.clone());
        record
    }

    /// Reserve global exposure before issuing a spend authorization. Panics
    /// (NEAR contract assert) if the agent is frozen or the reservation
    /// would exceed `max_allowed` — mirrors the TS `reserve_exposure`'s
    /// thrown errors, which become real `FunctionCallError::ExecutionError`
    /// protocol-level failures when a view/call hits this path.
    pub fn reserve_exposure(&mut self, agent_id: &str, amount: u128) -> AgentExposure {
        let mut e = self.must(agent_id);
        assert!(!e.frozen, "agent {} exposure is frozen", agent_id);
        let projected = e.outstanding.0 + e.reserved.0 + amount;
        assert!(
            projected <= e.max_allowed.0,
            "global exposure cap exceeded: {} > {} (agent {})",
            projected,
            e.max_allowed.0,
            agent_id
        );
        e.reserved = U128(e.reserved.0 + amount);
        e.updated_at = env::block_timestamp();
        self.exposure.insert(agent_id.to_string(), e.clone());
        e
    }

    /// A draw was confirmed: move reservation into outstanding exposure.
    pub fn activate_exposure(&mut self, agent_id: &str, amount: u128) {
        let mut e = self.must(agent_id);
        let moved = amount.min(e.reserved.0);
        e.reserved = U128(e.reserved.0 - moved);
        e.outstanding = U128(e.outstanding.0 + moved);
        e.updated_at = env::block_timestamp();
        self.exposure.insert(agent_id.to_string(), e);
    }

    /// Release an unused reservation. Ported 1:1 from
    /// `GlobalExposureManager.release_reservation`. Called from
    /// `scam_detection::record_dispute_spike`/`emergency_freeze` once an
    /// agent is frozen — a frozen agent will never spend its remaining
    /// reservation, so leaving it reserved forever would permanently lock
    /// that capacity out of the agent's own global exposure cap (and, once
    /// a multi-agent/shared-pool cap exists, out of every other agent's
    /// headroom too) with no way to recover it. Covered directly by this
    /// module's own tests below, and by `scam_detection`'s freeze tests.
    pub fn release_reservation(&mut self, agent_id: &str, amount: u128) {
        let mut e = self.must(agent_id);
        e.reserved = U128(if amount > e.reserved.0 { 0 } else { e.reserved.0 - amount });
        e.updated_at = env::block_timestamp();
        self.exposure.insert(agent_id.to_string(), e);
    }

    /// A repayment was reported: reduce outstanding exposure. Ported 1:1
    /// from `GlobalExposureManager.decrease_exposure`. Called from
    /// `SpendGuard::repay_credit_line` once the admin has independently
    /// verified a real repayment against the agent's outstanding draw —
    /// same trust model as `request_spend_authorization`'s metrics (an
    /// admin-verified fact, never a self-declared agent claim) — making
    /// this a genuine revolving credit line instead of a one-shot budget:
    /// an agent that repays frees up the same global exposure headroom a
    /// later `request_spend_authorization` call checks against. Covered
    /// directly by this module's own tests.
    pub fn decrease_exposure(&mut self, agent_id: &str, amount: u128) {
        let mut e = self.must(agent_id);
        e.outstanding = U128(if amount > e.outstanding.0 { 0 } else { e.outstanding.0 - amount });
        e.updated_at = env::block_timestamp();
        self.exposure.insert(agent_id.to_string(), e);
    }

    /// The circuit breaker: hard-stop an agent regardless of remaining
    /// budget. Called by `scam_detection.rs` on a dispute-rate spike.
    pub fn freeze_agent_exposure(&mut self, agent_id: &str) {
        let mut e = self.must(agent_id);
        e.frozen = true;
        e.updated_at = env::block_timestamp();
        self.exposure.insert(agent_id.to_string(), e);
    }

    pub fn get(&self, agent_id: &str) -> Option<AgentExposure> {
        self.exposure.get(agent_id).cloned()
    }

    fn must(&self, agent_id: &str) -> AgentExposure {
        self.exposure
            .get(agent_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(&format!("no exposure record for agent {}", agent_id)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn book() -> ExposureBook {
        testing_env!(VMContextBuilder::new().build());
        ExposureBook::new(b"t_exp".to_vec())
    }

    #[test]
    fn ensure_agent_creates_then_only_raises_the_cap() {
        let mut b = book();
        let e = b.ensure_agent("a1", 100);
        assert_eq!(e.max_allowed.0, 100);
        let e = b.ensure_agent("a1", 50); // lower cap request is ignored, never silently lowered
        assert_eq!(e.max_allowed.0, 100);
        let e = b.ensure_agent("a1", 200);
        assert_eq!(e.max_allowed.0, 200);
    }

    #[test]
    fn reserve_exposure_refuses_to_exceed_the_cap() {
        let mut b = book();
        b.ensure_agent("a1", 100);
        b.reserve_exposure("a1", 60);
        let e = b.get("a1").unwrap();
        assert_eq!(e.reserved.0, 60);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut b2 = book();
            b2.ensure_agent("a1", 100);
            b2.reserve_exposure("a1", 60);
            b2.reserve_exposure("a1", 60); // 120 > 100
        }));
        assert!(result.is_err(), "reserving past the cap must panic (protocol-level rejection)");
    }

    #[test]
    fn activate_then_decrease_moves_reserved_into_outstanding_then_back_down() {
        let mut b = book();
        b.ensure_agent("a1", 100);
        b.reserve_exposure("a1", 40);
        b.activate_exposure("a1", 40);
        let e = b.get("a1").unwrap();
        assert_eq!(e.reserved.0, 0);
        assert_eq!(e.outstanding.0, 40);
        b.decrease_exposure("a1", 40);
        let e = b.get("a1").unwrap();
        assert_eq!(e.outstanding.0, 0);
    }

    #[test]
    fn release_reservation_never_goes_negative() {
        let mut b = book();
        b.ensure_agent("a1", 100);
        b.reserve_exposure("a1", 10);
        b.release_reservation("a1", 999);
        let e = b.get("a1").unwrap();
        assert_eq!(e.reserved.0, 0);
    }

    #[test]
    fn freeze_blocks_further_reservation() {
        let mut b = book();
        b.ensure_agent("a1", 100);
        b.freeze_agent_exposure("a1");
        let e = b.get("a1").unwrap();
        assert!(e.frozen);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut b2 = book();
            b2.ensure_agent("a1", 100);
            b2.freeze_agent_exposure("a1");
            b2.reserve_exposure("a1", 1);
        }));
        assert!(result.is_err(), "a frozen agent must never be able to reserve more exposure");
    }
}
