//! AgentRegistry — on-chain identity, stake, reputation and credit score for
//! autonomous agents. Mirrors `lib/ledger/contracts/agent_registry.ts`.
//!
//! Built with Odra (https://odra.dev). Build with `cargo odra build` and deploy
//! the resulting WASM to Casper Testnet (see `scripts/deploy_testnet.ts`).

use odra::casper_types::U512;
use odra::prelude::*;

/// On-chain record for a single agent.
#[odra::odra_type]
pub struct Agent {
    pub agent_id: String,
    pub owner_public_key: String,
    pub agent_public_key: String,
    pub service_type: String,
    pub stake: U512,
    pub total_jobs_completed: u64,
    /// Sum of realized x402 revenue (motes) — the cash-flow the credit policy reads.
    pub revenue_total: U512,
    /// 0..100 evidence accuracy.
    pub accuracy_score: u64,
    /// dispute rate in basis points (0..10000).
    pub dispute_rate_bps: u64,
    /// 0..100 reputation.
    pub reputation_score: u64,
    /// 0..100 underwriting score.
    pub credit_score: u64,
    pub active: bool,
}

#[odra::event]
pub struct AgentRegistered {
    pub agent_id: String,
    pub service_type: String,
}

#[odra::event]
pub struct Staked {
    pub agent_id: String,
    pub amount: U512,
    pub total_stake: U512,
}

#[odra::event]
pub struct StakeSlashed {
    pub agent_id: String,
    pub amount: U512,
    pub reason_hash: String,
}

#[odra::event]
pub struct ReputationUpdated {
    pub agent_id: String,
    pub previous: u64,
    pub current: u64,
    pub evidence_hash: String,
}

#[odra::event]
pub struct CreditScoreSet {
    pub agent_id: String,
    pub credit_score: u64,
}

#[odra::module(events = [AgentRegistered, Staked, StakeSlashed, ReputationUpdated, CreditScoreSet])]
pub struct AgentRegistry {
    agents: Mapping<String, Agent>,
    /// Address allowed to mutate reputation / credit / slashing (the protocol owner).
    admin: Var<Address>,
}

#[odra::module]
impl AgentRegistry {
    /// Initialize with the deployer as admin.
    pub fn init(&mut self) {
        self.admin.set(self.env().caller());
    }

    pub fn register_agent(
        &mut self,
        agent_id: String,
        service_type: String,
        agent_public_key: String,
    ) {
        if self.agents.get(&agent_id).is_some() {
            self.env().revert(Error::AlreadyRegistered);
        }
        let agent = Agent {
            agent_id: agent_id.clone(),
            owner_public_key: self.env().caller().to_string(),
            agent_public_key,
            service_type: service_type.clone(),
            stake: U512::zero(),
            total_jobs_completed: 0,
            revenue_total: U512::zero(),
            accuracy_score: 80,
            dispute_rate_bps: 0,
            reputation_score: 70,
            credit_score: 0,
            active: true,
        };
        self.agents.set(&agent_id, agent);
        self.env().emit_event(AgentRegistered {
            agent_id,
            service_type,
        });
    }

    /// Stake collateral (attached CSPR is held by the contract).
    #[odra(payable)]
    pub fn stake(&mut self, agent_id: String) {
        let amount = self.env().attached_value();
        let mut agent = self.must(&agent_id);
        agent.stake += amount;
        let total = agent.stake;
        self.agents.set(&agent_id, agent);
        self.env().emit_event(Staked {
            agent_id,
            amount,
            total_stake: total,
        });
    }

    pub fn slash(&mut self, agent_id: String, amount: U512, reason_hash: String) {
        self.only_admin();
        let mut agent = self.must(&agent_id);
        let slashed = if amount > agent.stake {
            agent.stake
        } else {
            amount
        };
        agent.stake -= slashed;
        self.agents.set(&agent_id, agent);
        self.env().emit_event(StakeSlashed {
            agent_id,
            amount: slashed,
            reason_hash,
        });
    }

    /// Apply a signed reputation delta (clamped 0..100).
    pub fn update_reputation(&mut self, agent_id: String, delta: i64, evidence_hash: String) {
        self.only_admin();
        let mut agent = self.must(&agent_id);
        let prev = agent.reputation_score;
        let next = (prev as i64 + delta).clamp(0, 100) as u64;
        agent.reputation_score = next;
        self.agents.set(&agent_id, agent);
        self.env().emit_event(ReputationUpdated {
            agent_id,
            previous: prev,
            current: next,
            evidence_hash,
        });
    }

    pub fn set_credit_score(&mut self, agent_id: String, score: u64) {
        self.only_admin();
        let mut agent = self.must(&agent_id);
        agent.credit_score = score.min(100);
        let credit_score = agent.credit_score;
        self.agents.set(&agent_id, agent);
        self.env().emit_event(CreditScoreSet {
            agent_id,
            credit_score,
        });
    }

    /// Record a completed job: realized revenue + accuracy EMA + dispute tracking.
    pub fn record_job(
        &mut self,
        agent_id: String,
        revenue: U512,
        accuracy_sample: u64,
        disputed: bool,
    ) {
        self.only_admin();
        let mut agent = self.must(&agent_id);
        agent.revenue_total += revenue;
        agent.total_jobs_completed += 1;
        agent.accuracy_score = (agent.accuracy_score * 7 + accuracy_sample * 3) / 10;
        let n = agent.total_jobs_completed;
        let prior = agent.dispute_rate_bps * (n - 1);
        agent.dispute_rate_bps = (prior + if disputed { 10000 } else { 0 }) / n;
        self.agents.set(&agent_id, agent);
    }

    pub fn get_agent(&self, agent_id: String) -> Option<Agent> {
        self.agents.get(&agent_id)
    }

    fn must(&self, agent_id: &str) -> Agent {
        self.agents
            .get(&agent_id.to_string())
            .unwrap_or_revert_with(&self.env(), Error::UnknownAgent)
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    AlreadyRegistered = 1,
    UnknownAgent = 2,
    Unauthorized = 3,
    NotInitialized = 4,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    fn deploy() -> (HostEnv, AgentRegistryHostRef) {
        let env = odra_test::env();
        let registry = AgentRegistry::deploy(&env, NoArgs);
        (env, registry)
    }

    #[test]
    fn registers_an_agent_with_starting_profile() {
        let (_env, mut registry) = deploy();
        registry.register_agent(
            "a1".to_string(),
            "rwa.energy".to_string(),
            "01ab".to_string(),
        );
        let agent = registry.get_agent("a1".to_string()).expect("agent exists");
        assert_eq!(agent.service_type, "rwa.energy");
        assert_eq!(agent.reputation_score, 70);
        assert_eq!(agent.accuracy_score, 80);
        assert!(agent.active);
    }

    #[test]
    fn rejects_duplicate_registration() {
        let (_env, mut registry) = deploy();
        registry.register_agent("a1".to_string(), "svc".to_string(), "01ab".to_string());
        let err =
            registry.try_register_agent("a1".to_string(), "svc".to_string(), "01cd".to_string());
        assert!(err.is_err());
    }

    #[test]
    fn staking_accumulates_collateral() {
        let (env, mut registry) = deploy();
        registry.register_agent("a1".to_string(), "svc".to_string(), "01ab".to_string());
        registry.with_tokens(U512::from(50)).stake("a1".to_string());
        assert_eq!(
            registry.get_agent("a1".to_string()).unwrap().stake,
            U512::from(50)
        );
        let _ = env;
    }

    #[test]
    fn reputation_update_is_clamped_and_admin_only() {
        let (env, mut registry) = deploy();
        registry.register_agent("a1".to_string(), "svc".to_string(), "01ab".to_string());
        registry.update_reputation("a1".to_string(), 50, "0xev".to_string());
        assert_eq!(
            registry
                .get_agent("a1".to_string())
                .unwrap()
                .reputation_score,
            100
        ); // 70+50 clamped

        // A non-admin caller cannot mutate reputation.
        let intruder = env.get_account(1);
        env.set_caller(intruder);
        let denied = registry.try_update_reputation("a1".to_string(), -10, "0xev".to_string());
        assert!(denied.is_err());
    }

    #[test]
    fn record_job_tracks_revenue_and_dispute_rate() {
        let (_env, mut registry) = deploy();
        registry.register_agent("a1".to_string(), "svc".to_string(), "01ab".to_string());
        registry.record_job("a1".to_string(), U512::from(1000), 90, false);
        registry.record_job("a1".to_string(), U512::from(500), 90, true);
        let agent = registry.get_agent("a1".to_string()).unwrap();
        assert_eq!(agent.revenue_total, U512::from(1500));
        assert_eq!(agent.total_jobs_completed, 2);
        assert_eq!(agent.dispute_rate_bps, 5000); // 1 of 2 disputed
    }
}
