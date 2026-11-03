//! scam_detection — the circuit breaker. A spike in an agent's dispute rate
//! freezes its `ExposureBook` record, releases any unspent reservation back
//! (frozen capacity is never coming back to spend, so it shouldn't stay
//! locked), AND revokes its live spend key in one admin-triggered call, so
//! the agent is cut off even if its budget was nowhere near exhausted. This
//! is what proves "AI Security & Defense" is a real second axis on top of
//! "Agent Economy"'s spending limits.

use near_sdk::{env, Promise, PublicKey};

use crate::exposure::ExposureBook;

/// Disputes at or above this count within the tracked window trip the
/// breaker. Kept small and explicit (not pulled from policy) so the demo's
/// "simulate a spike" step is easy to reason about and to show a judge.
pub const DISPUTE_SPIKE_THRESHOLD: u64 = 3;

/// Record `count` additional disputes against `agent_id`. If the running
/// total crosses `DISPUTE_SPIKE_THRESHOLD`, freeze the agent's exposure and
/// return a `Promise` that revokes its live spend key — the real,
/// protocol-level kill switch (`spend_key::revoke_spend_key`). Returns
/// `None` when the spike threshold has not yet been crossed (no key to
/// revoke, nothing further to do on-chain).
pub fn record_dispute_spike(
    exposure: &mut ExposureBook,
    dispute_counts: &mut near_sdk::store::LookupMap<String, u64>,
    agent_id: &str,
    count: u64,
    spend_key_public_key: Option<PublicKey>,
) -> Option<Promise> {
    let current = dispute_counts.get(agent_id).copied().unwrap_or(0);
    let updated = current + count;
    dispute_counts.insert(agent_id.to_string(), updated);

    if updated < DISPUTE_SPIKE_THRESHOLD {
        return None;
    }

    exposure.freeze_agent_exposure(agent_id);
    release_unspent_reservation(exposure, agent_id);
    env::log_str(&format!(
        "spend_guard: agent {} tripped the dispute-spike breaker ({} disputes >= threshold {}) — exposure frozen",
        agent_id, updated, DISPUTE_SPIKE_THRESHOLD
    ));

    spend_key_public_key.map(crate::spend_key::revoke_spend_key)
}

/// A frozen agent will never spend the rest of its reservation — release it
/// back immediately rather than leaving that capacity permanently locked
/// against the agent's own `max_allowed` cap. Safe to call on an agent with
/// zero remaining reservation (e.g. one that had already fully drawn its
/// line before being frozen): `release_reservation` floors at zero.
fn release_unspent_reservation(exposure: &mut ExposureBook, agent_id: &str) {
    if let Some(e) = exposure.get(agent_id) {
        if e.reserved.0 > 0 {
            exposure.release_reservation(agent_id, e.reserved.0);
        }
    }
}

/// Emergency freeze with no dispute-count bookkeeping — used for an
/// immediate, deliberate admin action (e.g. an external fraud signal) rather
/// than an accumulated spike. Still revokes the real key.
pub fn emergency_freeze(
    exposure: &mut ExposureBook,
    agent_id: &str,
    spend_key_public_key: PublicKey,
) -> Promise {
    exposure.freeze_agent_exposure(agent_id);
    release_unspent_reservation(exposure, agent_id);
    env::log_str(&format!("spend_guard: agent {} emergency-frozen by admin", agent_id));
    crate::spend_key::revoke_spend_key(spend_key_public_key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn setup() -> (ExposureBook, near_sdk::store::LookupMap<String, u64>) {
        let mut ctx = VMContextBuilder::new();
        ctx.current_account_id("spendguard.testnet".parse().unwrap());
        testing_env!(ctx.build());
        (ExposureBook::new(b"t_exp2".to_vec()), near_sdk::store::LookupMap::new(b"t_disp".to_vec()))
    }

    #[test]
    fn below_threshold_does_not_freeze_or_revoke() {
        let (mut exposure, mut disputes) = setup();
        exposure.ensure_agent("a1", 1_000);
        let result = record_dispute_spike(&mut exposure, &mut disputes, "a1", 1, None);
        assert!(result.is_none());
        assert!(!exposure.get("a1").unwrap().frozen);
    }

    #[test]
    fn crossing_threshold_freezes_even_without_a_key_to_revoke() {
        let (mut exposure, mut disputes) = setup();
        exposure.ensure_agent("a1", 1_000);
        let r1 = record_dispute_spike(&mut exposure, &mut disputes, "a1", 2, None);
        assert!(r1.is_none(), "2 disputes stays below the threshold of 3");
        let r2 = record_dispute_spike(&mut exposure, &mut disputes, "a1", 1, None);
        assert!(r2.is_none(), "no public key supplied, so nothing to revoke, but the freeze must still apply");
        assert!(exposure.get("a1").unwrap().frozen, "3rd dispute crosses the threshold and must freeze exposure");
    }

    #[test]
    fn crossing_threshold_with_a_key_schedules_revocation() {
        let (mut exposure, mut disputes) = setup();
        exposure.ensure_agent("a1", 1_000);
        let pk: near_sdk::PublicKey = "ed25519:8qnA1LSJMnGYoUdHoTQ1SBayJQYJvhzvT4tdF8RVLTPG".parse().unwrap();
        let result = record_dispute_spike(&mut exposure, &mut disputes, "a1", 5, Some(pk));
        assert!(result.is_some(), "crossing the threshold with a known key must schedule a revoke_key promise");
        assert!(exposure.get("a1").unwrap().frozen);
    }

    #[test]
    fn crossing_threshold_releases_the_agents_unspent_reservation() {
        let (mut exposure, mut disputes) = setup();
        exposure.ensure_agent("a1", 1_000);
        exposure.reserve_exposure("a1", 700);
        record_dispute_spike(&mut exposure, &mut disputes, "a1", 3, None);
        let e = exposure.get("a1").unwrap();
        assert!(e.frozen);
        assert_eq!(e.reserved.0, 0, "frozen capacity must not stay locked as an unspendable reservation");
    }

    #[test]
    fn freezing_an_agent_with_a_partially_spent_line_only_releases_what_is_left() {
        let (mut exposure, mut disputes) = setup();
        exposure.ensure_agent("a1", 1_000);
        exposure.reserve_exposure("a1", 700);
        exposure.activate_exposure("a1", 300); // spent 300, 400 still reserved/unspent
        record_dispute_spike(&mut exposure, &mut disputes, "a1", 3, None);
        let e = exposure.get("a1").unwrap();
        assert_eq!(e.reserved.0, 0, "the remaining unspent 400 must be released");
        assert_eq!(e.outstanding.0, 300, "the already-spent 300 stays outstanding — a freeze is not a repayment");
    }

    #[test]
    fn emergency_freeze_also_releases_the_unspent_reservation() {
        let (mut exposure, mut disputes) = setup();
        let _ = &mut disputes; // unused in this test; kept for setup() symmetry
        exposure.ensure_agent("a1", 1_000);
        exposure.reserve_exposure("a1", 500);
        let pk: near_sdk::PublicKey = "ed25519:8qnA1LSJMnGYoUdHoTQ1SBayJQYJvhzvT4tdF8RVLTPG".parse().unwrap();
        let _ = emergency_freeze(&mut exposure, "a1", pk);
        let e = exposure.get("a1").unwrap();
        assert!(e.frozen);
        assert_eq!(e.reserved.0, 0);
    }
}
