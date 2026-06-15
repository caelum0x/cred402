//! RiskPolicyManager — the upgradable underwriting brain. Casper's upgradable
//! contracts let the policy evolve v1 -> v2 without redeploying the pool or
//! registry. Mirrors `lib/ledger/contracts/risk_policy_manager.ts` and
//! `lib/core/risk_policy.ts`.
//!
//!   credit_line = base_limit * stake_mult * dispute_penalty * accuracy_mult
//!
//! All multipliers are expressed in basis points (10000 = 1.0).

use odra::casper_types::U512;
use odra::prelude::*;

/// Inputs the underwriter reads from the AgentRegistry + X402ReceiptRegistry.
#[odra::odra_type]
pub struct AgentMetrics {
    pub revenue_30d: U512,
    pub stake: U512,
    pub dispute_rate_bps: u64,
    pub accuracy_score: u64,
    pub total_jobs: u64,
}

#[odra::odra_type]
pub struct CreditDecision {
    pub credit_line: U512,
    pub credit_score: u64,
    pub interest_rate_bps: u64,
    pub policy_version: u8,
}

#[odra::event]
pub struct PolicyUpgraded {
    pub previous: u8,
    pub current: u8,
}

#[odra::module(events = [PolicyUpgraded])]
pub struct RiskPolicyManager {
    /// 1 => v1, 2 => v2.
    version: Var<u8>,
    admin: Var<Address>,
}

#[odra::module]
impl RiskPolicyManager {
    pub fn init(&mut self) {
        self.version.set(1);
        self.admin.set(self.env().caller());
    }

    pub fn version(&self) -> u8 {
        self.version.get_or_default()
    }

    /// The headline upgradable-contract action.
    pub fn upgrade(&mut self, version: u8) {
        self.only_admin();
        if version != 1 && version != 2 {
            self.env().revert(Error::UnknownPolicy);
        }
        let previous = self.version.get_or_default();
        self.version.set(version);
        self.env().emit_event(PolicyUpgraded {
            previous,
            current: version,
        });
    }

    pub fn evaluate(&self, m: AgentMetrics) -> CreditDecision {
        match self.version.get_or_default() {
            2 => self.policy_v2(m),
            _ => self.policy_v1(m),
        }
    }

    fn policy_v1(&self, m: AgentMetrics) -> CreditDecision {
        let base = m.revenue_30d * U512::from(30u64) / U512::from(100u64); // 0.30
        let stake_cspr = (m.stake / U512::from(1_000_000_000u64)).as_u64();
        let stake_mult = core::cmp::min(20000, 10000 + stake_cspr * 100);
        let dispute_pen = core::cmp::max(2000i64, 10000 - (m.dispute_rate_bps as i64) * 5) as u64;
        let accuracy_mult = m.accuracy_score * 100;
        let credit_line = apply_bps(
            apply_bps(apply_bps(base, stake_mult), dispute_pen),
            accuracy_mult,
        );
        let credit_score = clamp_score(
            (50 * m.accuracy_score + 30 * 70 + 20 * (10000 - m.dispute_rate_bps) / 100) / 100,
        );
        CreditDecision {
            credit_line,
            credit_score,
            interest_rate_bps: interest_from_score(credit_score),
            policy_version: 1,
        }
    }

    fn policy_v2(&self, m: AgentMetrics) -> CreditDecision {
        let base = m.revenue_30d * U512::from(35u64) / U512::from(100u64); // 0.35
        let stake_cspr = (m.stake / U512::from(1_000_000_000u64)).as_u64();
        let stake_mult = core::cmp::min(16000, 10000 + stake_cspr * 100 / 15 * 10);
        let dispute_pen = core::cmp::max(1500i64, 10000 - (m.dispute_rate_bps as i64) * 8) as u64;
        let accuracy_mult = m.accuracy_score * 100;
        let throughput = core::cmp::min(12500, 10000 + m.total_jobs * 10);
        let credit_line = apply_bps(
            apply_bps(
                apply_bps(apply_bps(base, stake_mult), dispute_pen),
                accuracy_mult,
            ),
            throughput,
        );
        let credit_score = clamp_score(
            (45 * m.accuracy_score
                + 25 * 70
                + 20 * (10000 - m.dispute_rate_bps) / 100
                + 10 * core::cmp::min(100, m.total_jobs / 5))
                / 100,
        );
        CreditDecision {
            credit_line,
            credit_score,
            interest_rate_bps: interest_from_score(credit_score),
            policy_version: 2,
        }
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

fn apply_bps(value: U512, bps: u64) -> U512 {
    value * U512::from(bps) / U512::from(10000u64)
}

fn clamp_score(s: u64) -> u64 {
    s.min(100)
}

/// Higher score => cheaper credit, ~8% (great) to ~22% APR (weak).
fn interest_from_score(score: u64) -> u64 {
    // 2200 - score/100 * 1400, in bps
    2200 - score * 14
}

#[odra::odra_error]
pub enum Error {
    UnknownPolicy = 1,
    Unauthorized = 2,
    NotInitialized = 3,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    const CSPR: u64 = 1_000_000_000;

    fn deploy() -> (HostEnv, RiskPolicyManagerHostRef) {
        let env = odra_test::env();
        let mgr = RiskPolicyManager::deploy(&env, NoArgs);
        (env, mgr)
    }

    fn metrics() -> AgentMetrics {
        AgentMetrics {
            revenue_30d: U512::from(128 * CSPR),
            stake: U512::from(50 * CSPR),
            dispute_rate_bps: 170,
            accuracy_score: 92,
            total_jobs: 412,
        }
    }

    #[test]
    fn v1_produces_a_positive_line_and_sane_interest() {
        let (_env, mgr) = deploy();
        assert_eq!(mgr.version(), 1);
        let d = mgr.evaluate(metrics());
        assert_eq!(d.policy_version, 1);
        assert!(d.credit_line > U512::zero());
        assert!(d.credit_score > 0 && d.credit_score <= 100);
        // interest 8%..22% APR
        assert!(d.interest_rate_bps >= 800 && d.interest_rate_bps <= 2200);
    }

    #[test]
    fn upgrade_to_v2_rewards_throughput() {
        let (_env, mut mgr) = deploy();
        let v1 = mgr.evaluate(metrics());
        mgr.upgrade(2);
        assert_eq!(mgr.version(), 2);
        let v2 = mgr.evaluate(metrics());
        assert_eq!(v2.policy_version, 2);
        // 412 completed jobs lift the throughput multiplier, so v2 >= v1.
        assert!(v2.credit_line > v1.credit_line);
    }

    #[test]
    fn rejects_unknown_policy_version() {
        let (_env, mut mgr) = deploy();
        assert!(mgr.try_upgrade(9).is_err());
    }

    #[test]
    fn upgrade_is_admin_only() {
        let (env, mut mgr) = deploy();
        let intruder = env.get_account(1);
        env.set_caller(intruder);
        assert!(mgr.try_upgrade(2).is_err());
    }
}
