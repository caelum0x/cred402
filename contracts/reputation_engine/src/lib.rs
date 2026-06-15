//! ReputationEngine (p2 §6.6) — derives a multi-dimensional reputation and folds
//! it into a single weighted score (basis-point integer math). Mirrors
//! `lib/ledger/contracts/reputation_engine.ts`.

use odra::prelude::*;

#[odra::odra_type]
pub struct ReputationDimensions {
    pub quality_score: u64,
    pub timeliness_score: u64,
    pub dispute_score: u64,
    pub revenue_score: u64,
    pub repayment_score: u64,
    pub category_expertise_score: u64,
    pub collusion_penalty: u64,
}

#[odra::module]
pub struct ReputationEngine {
    /// Optional cached score per agent.
    scores: Mapping<String, u64>,
}

#[odra::module]
impl ReputationEngine {
    pub fn init(&mut self) {}

    /// Compute the composite score from dimensions. Weights (in bps, sum 10000):
    /// quality 3000, timeliness 1000, dispute 2000, revenue 1500, repayment 1500,
    /// expertise 1000; collusion penalty subtracted.
    pub fn compute(&self, d: ReputationDimensions) -> u64 {
        let weighted = d.quality_score * 3000
            + d.timeliness_score * 1000
            + d.dispute_score * 2000
            + d.revenue_score * 1500
            + d.repayment_score * 1500
            + d.category_expertise_score * 1000;
        let base = weighted / 10000;
        let score = base.saturating_sub(d.collusion_penalty);
        score.min(100)
    }

    pub fn set_score(&mut self, agent_id: String, dimensions: ReputationDimensions) -> u64 {
        let score = self.compute(dimensions);
        self.scores.set(&agent_id, score);
        score
    }

    pub fn get_score(&self, agent_id: String) -> u64 {
        self.scores.get(&agent_id).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, ReputationEngineHostRef) {
        let env = odra_test::env();
        let engine = ReputationEngine::deploy(&env, NoArgs);
        (env, engine)
    }

    fn dims(quality: u64, penalty: u64) -> ReputationDimensions {
        ReputationDimensions {
            quality_score: quality,
            timeliness_score: 90,
            dispute_score: 95,
            revenue_score: 80,
            repayment_score: 100,
            category_expertise_score: 88,
            collusion_penalty: penalty,
        }
    }

    #[test]
    fn composite_score_stays_within_0_100() {
        let (_env, engine) = deploy();
        assert!(engine.compute(dims(100, 0)) <= 100);
        assert_eq!(engine.compute(dims(0, 200)), 0); // penalty drives it to the floor
    }

    #[test]
    fn collusion_penalty_lowers_the_score() {
        let (_env, engine) = deploy();
        let clean = engine.compute(dims(90, 0));
        let penalized = engine.compute(dims(90, 15));
        assert_eq!(penalized, clean.saturating_sub(15));
    }

    #[test]
    fn set_and_get_persist_the_score() {
        let (_env, mut engine) = deploy();
        let written = engine.set_score("a1".to_string(), dims(90, 0));
        assert_eq!(engine.get_score("a1".to_string()), written);
        assert_eq!(engine.get_score("unknown".to_string()), 0);
    }
}
