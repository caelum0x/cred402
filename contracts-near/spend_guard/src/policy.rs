//! Policy — the underwriting brain, ported from Casper/Odra's
//! `contracts/risk_policy_manager/src/lib.rs` to `near-sdk-rs`.
//!
//!   credit_line = base_limit(revenue_30d) * stake_mult * dispute_penalty * accuracy_mult
//!
//! All multipliers are expressed in basis points (10000 = 1.0), exactly as the
//! Casper version does. The only semantic change from the Casper source is the
//! unit of `stake`: Casper denominates `stake` in motes (1 CSPR = 1_000_000_000
//! motes), NEAR denominates every native amount in yoctoNEAR (1 NEAR =
//! 10^24 yoctoNEAR) — 15 orders of magnitude larger per native unit. Porting
//! the Casper divisor (`1_000_000_000u64`) unchanged and applying it to a
//! yoctoNEAR amount does NOT make `stake_near` floor to 0 — it does the
//! opposite: it produces a number 10^15 times too large (e.g. a real 50 NEAR
//! stake reads back as `50_000_000_000_000_000`), which instantly saturates
//! `min(20000, 10000 + stake_near * 100)` at its 20000bps (2.0x) ceiling for
//! virtually any nonzero stake. The bug silently maxes out every agent's
//! stake multiplier regardless of how much (or little) it actually staked —
//! not a crash, not an error, just a wrong, inflated credit line. This was
//! caught in a disposable toolchain rehearsal before this file was written
//! (see `HACKATHON-NEAR-2026-PLAN.md`) and is fixed here by using
//! `YOCTO_PER_NEAR` instead.

use near_sdk::json_types::U128;
use near_sdk::near;

/// 1 NEAR = 10^24 yoctoNEAR. This is the NEAR-native replacement for Casper's
/// `CSPR = 1_000_000_000` motes constant — the exact bug this module exists to
/// avoid repeating.
pub const YOCTO_PER_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// Inputs the underwriter reads from the agent's verified on-chain x402
/// revenue + reputation signals. Mirrors Casper's `AgentMetrics`. yoctoNEAR
/// amounts are `U128` (serializes as a JSON string) because raw u128/u64
/// values above 2^53 are not safely representable as JSON numbers in
/// JavaScript — every real credit-line amount on NEAR exceeds that.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentMetrics {
    /// Verified 30-day x402 revenue, in yoctoNEAR.
    pub revenue_30d: U128,
    /// Staked collateral, in yoctoNEAR.
    pub stake: U128,
    /// Dispute rate in basis points (10000 = 100% disputed).
    pub dispute_rate_bps: u64,
    /// Evidence/report accuracy score, 0..100.
    pub accuracy_score: u64,
    pub total_jobs: u64,
}

#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreditDecision {
    /// Approved credit line, in yoctoNEAR — this becomes the Function Call
    /// Access Key's `allowance`.
    pub credit_line: U128,
    pub credit_score: u64,
    pub interest_rate_bps: u64,
    pub policy_version: u8,
}

/// Policy v1 — ported 1:1 from `RiskPolicyManager::policy_v1` (Casper/Odra),
/// with the CSPR->yoctoNEAR unit fix described above. Pure function: no
/// contract state, no storage reads, so it is trivial to unit test and to
/// swap for a v2 later without touching exposure/key logic.
pub fn policy_v1(m: &AgentMetrics) -> CreditDecision {
    let revenue_30d: u128 = m.revenue_30d.into();
    let stake: u128 = m.stake.into();

    let base = revenue_30d * 30 / 100; // 0.30

    let stake_near = stake / YOCTO_PER_NEAR;
    let stake_mult = core::cmp::min(20_000u128, 10_000u128 + stake_near * 100);

    let dispute_pen = core::cmp::max(2_000i64, 10_000i64 - (m.dispute_rate_bps as i64) * 5) as u128;
    let accuracy_mult = (m.accuracy_score as u128) * 100;

    let credit_line = apply_bps(apply_bps(apply_bps(base, stake_mult), dispute_pen), accuracy_mult);

    let credit_score = clamp_score(
        (50 * m.accuracy_score + 30 * 70 + 20 * (10_000 - m.dispute_rate_bps.min(10_000)) / 100) / 100,
    );

    CreditDecision {
        credit_line: U128(credit_line),
        credit_score,
        interest_rate_bps: interest_from_score(credit_score),
        policy_version: 1,
    }
}

fn apply_bps(value: u128, bps: u128) -> u128 {
    value * bps / 10_000
}

fn clamp_score(s: u64) -> u64 {
    s.min(100)
}

/// Higher score => cheaper credit, ~8% (great) to ~22% APR (weak). Identical
/// to the Casper source — this formula doesn't touch the buggy unit.
fn interest_from_score(score: u64) -> u64 {
    2_200 - score * 14
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Casper fixture (`contracts/risk_policy_manager/src/lib.rs::tests::metrics`)
    /// reinterpreted at NEAR scale: same numbers, yoctoNEAR instead of motes
    /// (128 NEAR revenue, 50 NEAR stake instead of 128/50 CSPR).
    fn metrics() -> AgentMetrics {
        AgentMetrics {
            revenue_30d: U128(128 * YOCTO_PER_NEAR),
            stake: U128(50 * YOCTO_PER_NEAR),
            dispute_rate_bps: 170,
            accuracy_score: 92,
            total_jobs: 412,
        }
    }

    #[test]
    fn v1_produces_a_positive_line_and_sane_interest() {
        let d = policy_v1(&metrics());
        assert_eq!(d.policy_version, 1);
        assert!(d.credit_line.0 > 0, "credit line should be positive");
        assert!(d.credit_score > 0 && d.credit_score <= 100);
        assert!(d.interest_rate_bps >= 800 && d.interest_rate_bps <= 2200);
    }

    /// Regression for the exact bug the module-level doc comment describes:
    /// porting the Casper CSPR divisor (1e9) unchanged and applying it to a
    /// yoctoNEAR stake does NOT floor to 0 — it overshoots by 15 orders of
    /// magnitude and saturates `stake_mult` at its 20000bps ceiling for
    /// virtually any nonzero stake. With the correct `YOCTO_PER_NEAR`
    /// divisor, the same 50 NEAR stake reads back as plain `50`.
    #[test]
    fn stake_multiplier_uses_yocto_near_not_the_casper_cspr_divisor() {
        let d = metrics();
        let wrong_divisor_stake_units = d.stake.0 / 1_000_000_000u128; // the Casper bug, reproduced
        assert_eq!(
            wrong_divisor_stake_units, 50_000_000_000_000_000,
            "sanity: the bug overshoots to an astronomically large 'CSPR-equivalent' count, not 0"
        );
        let buggy_stake_mult = core::cmp::min(20_000u128, 10_000u128 + wrong_divisor_stake_units * 100);
        assert_eq!(buggy_stake_mult, 20_000, "the bug saturates stake_mult at its ceiling for any real stake");

        let correct_stake_near = d.stake.0 / YOCTO_PER_NEAR;
        assert_eq!(correct_stake_near, 50, "50 NEAR staked must read back as 50, not a scaled-up garbage value");
        let correct_stake_mult = core::cmp::min(20_000u128, 10_000u128 + correct_stake_near * 100);
        assert_eq!(correct_stake_mult, 15_000, "with the fix, 50 NEAR staked gives a sane 1.5x multiplier, not the 2.0x ceiling");
    }

    /// Cross-check against `test/risk_policy.test.ts`'s `baseAgent()` fixture
    /// (lib/core/risk_policy.ts policyV1), confirming the ported bps math
    /// produces the identical credit_line once units are aligned 1
    /// CSPR-unit <-> 1 NEAR-unit (both scaled by their chain's native
    /// decimals) and the TS-only `category_multiplier` is forced to 1.0 —
    /// which is exactly what it evaluates to for the TS fixture's
    /// `service_type: "solar_output_verification"` (family "rwa", risk
    /// weight 10000bps = 1.0x, see `lib/core/service_categories.ts`).
    ///
    /// TS fixture: revenue_30d = 30 CSPR (30 x 1.0 CSPR receipts), stake = 50
    /// CSPR, dispute_rate = 0.02 (200bps), accuracy_score = 90.
    /// TS result (`policyV1`): base_limit = 9 CSPR, stake_multiplier = 1.5,
    /// dispute_penalty = 0.9, accuracy_multiplier = 0.9, category_multiplier
    /// = 1.0 => credit_line = 9 * 1.5 * 0.9 * 0.9 * 1.0 = 10.935 CSPR.
    #[test]
    fn credit_line_matches_the_ts_risk_policy_fixture_once_units_align() {
        let m = AgentMetrics {
            revenue_30d: U128(30 * YOCTO_PER_NEAR),
            stake: U128(50 * YOCTO_PER_NEAR),
            dispute_rate_bps: 200, // 0.02 fraction in the TS test
            accuracy_score: 90,
            total_jobs: 200,
        };
        let d = policy_v1(&m);
        // 10.935 NEAR, expressed in yoctoNEAR — must equal the TS fixture's
        // 10.935 CSPR expressed in motes, with CSPR/NEAR unit scales swapped.
        let expected = 10_935u128 * YOCTO_PER_NEAR / 1_000;
        assert_eq!(d.credit_line.0, expected, "ported bps math must match the TS reference formula exactly");
    }

    #[test]
    fn credit_score_and_interest_stay_in_documented_ranges_across_inputs() {
        for accuracy in [0u64, 1, 50, 92, 100] {
            for dispute_bps in [0u64, 170, 5_000, 10_000] {
                let m = AgentMetrics {
                    revenue_30d: U128(10 * YOCTO_PER_NEAR),
                    stake: U128(10 * YOCTO_PER_NEAR),
                    dispute_rate_bps: dispute_bps,
                    accuracy_score: accuracy,
                    total_jobs: 10,
                };
                let d = policy_v1(&m);
                assert!(d.credit_score <= 100);
                assert!(d.interest_rate_bps >= 800 && d.interest_rate_bps <= 2200);
            }
        }
    }
}
