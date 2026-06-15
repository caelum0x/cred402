//! DisputeCourt (p2 §6.9) — handles challenges against agents and issues
//! verdicts that the SlashingVault enforces. Mirrors
//! `lib/ledger/contracts/dispute_court.ts`.

use odra::casper_types::U512;
use odra::prelude::*;

/// 0 bad_evidence, 1 fake_receipt, 2 non_delivery, 3 payment_reversal,
/// 4 agent_default, 5 collusion, 6 oracle_manipulation, 7 metadata_fraud.
pub type DisputeType = u8;

/// 0 opened, 1 evidence_period, 2 under_review, 3 verdict_pending, 4 resolved, 5 closed.
pub type DisputeStatus = u8;

/// 0 none, 1 agent_wins, 2 agent_loses, 3 partial_fault, 4 inconclusive, 5 malicious_dispute.
pub type Verdict = u8;

#[odra::odra_type]
pub struct Dispute {
    pub dispute_id: String,
    pub dispute_type: DisputeType,
    pub complainant: String,
    pub respondent_agent: String,
    pub receipt_id: String,
    pub status: DisputeStatus,
    pub verdict: Verdict,
    pub slash_amount: U512,
    pub opened_at: u64,
    pub resolved_at: u64,
}

#[odra::event]
pub struct DisputeOpened {
    pub dispute_id: String,
    pub dispute_type: DisputeType,
    pub respondent_agent: String,
    pub complainant: String,
}

#[odra::event]
pub struct DisputeVerdictIssued {
    pub dispute_id: String,
    pub verdict: Verdict,
    pub slash_amount: U512,
    pub respondent_agent: String,
}

#[odra::event]
pub struct DisputeClosed {
    pub dispute_id: String,
}

#[odra::module(events = [DisputeOpened, DisputeVerdictIssued, DisputeClosed])]
pub struct DisputeCourt {
    disputes: Mapping<String, Dispute>,
    open_count: Mapping<String, u64>,
    admin: Var<Address>,
}

#[odra::module]
impl DisputeCourt {
    pub fn init(&mut self) {
        self.admin.set(self.env().caller());
    }

    pub fn open(
        &mut self,
        dispute_id: String,
        dispute_type: DisputeType,
        complainant: String,
        respondent_agent: String,
        receipt_id: String,
    ) {
        if self.disputes.get(&dispute_id).is_some() {
            self.env().revert(Error::DuplicateDispute);
        }
        let dispute = Dispute {
            dispute_id: dispute_id.clone(),
            dispute_type,
            complainant: complainant.clone(),
            respondent_agent: respondent_agent.clone(),
            receipt_id,
            status: 0,
            verdict: 0,
            slash_amount: U512::zero(),
            opened_at: self.env().get_block_time(),
            resolved_at: 0,
        };
        self.disputes.set(&dispute_id, dispute);
        let n = self.open_count.get(&respondent_agent).unwrap_or_default() + 1;
        self.open_count.set(&respondent_agent, n);
        self.env().emit_event(DisputeOpened {
            dispute_id,
            dispute_type,
            respondent_agent,
            complainant,
        });
    }

    /// Issue a verdict. Admin (governance/arbiter) gated — the judge agent only
    /// recommends off-chain.
    pub fn issue_verdict(&mut self, dispute_id: String, verdict: Verdict, slash_amount: U512) {
        self.only_admin();
        let mut d = self.must(&dispute_id);
        d.verdict = verdict;
        d.slash_amount = slash_amount;
        d.status = 4;
        d.resolved_at = self.env().get_block_time();
        let respondent = d.respondent_agent.clone();
        self.disputes.set(&dispute_id, d);
        self.env().emit_event(DisputeVerdictIssued {
            dispute_id,
            verdict,
            slash_amount,
            respondent_agent: respondent,
        });
    }

    pub fn close(&mut self, dispute_id: String) {
        self.only_admin();
        let mut d = self.must(&dispute_id);
        let respondent = d.respondent_agent.clone();
        d.status = 5;
        self.disputes.set(&dispute_id, d);
        let n = self.open_count.get(&respondent).unwrap_or_default();
        self.open_count.set(&respondent, n.saturating_sub(1));
        self.env().emit_event(DisputeClosed { dispute_id });
    }

    pub fn get_dispute(&self, dispute_id: String) -> Option<Dispute> {
        self.disputes.get(&dispute_id)
    }

    pub fn open_count(&self, agent_id: String) -> u64 {
        self.open_count.get(&agent_id).unwrap_or_default()
    }

    fn must(&self, dispute_id: &str) -> Dispute {
        self.disputes
            .get(&dispute_id.to_string())
            .unwrap_or_revert_with(&self.env(), Error::UnknownDispute)
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    DuplicateDispute = 1,
    UnknownDispute = 2,
    Unauthorized = 3,
    NotInitialized = 4,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, DisputeCourtHostRef) {
        let env = odra_test::env();
        let court = DisputeCourt::deploy(&env, NoArgs);
        (env, court)
    }

    #[test]
    fn open_verdict_close_lifecycle() {
        let (_env, mut court) = deploy();
        court.open(
            "d1".to_string(),
            0,
            "buyer".to_string(),
            "a1".to_string(),
            "r1".to_string(),
        );
        assert_eq!(court.open_count("a1".to_string()), 1);
        assert_eq!(court.get_dispute("d1".to_string()).unwrap().status, 0);

        court.issue_verdict(
            "d1".to_string(),
            2, /* agent_loses */
            U512::from(25u64),
        );
        let d = court.get_dispute("d1".to_string()).unwrap();
        assert_eq!(d.verdict, 2);
        assert_eq!(d.slash_amount, U512::from(25u64));
        assert_eq!(d.status, 4);

        court.close("d1".to_string());
        assert_eq!(court.get_dispute("d1".to_string()).unwrap().status, 5);
        assert_eq!(court.open_count("a1".to_string()), 0);
    }

    #[test]
    fn rejects_duplicate_dispute() {
        let (_env, mut court) = deploy();
        court.open(
            "d1".to_string(),
            1,
            "b".to_string(),
            "a1".to_string(),
            "r1".to_string(),
        );
        assert!(court
            .try_open(
                "d1".to_string(),
                1,
                "b".to_string(),
                "a1".to_string(),
                "r1".to_string()
            )
            .is_err());
    }

    #[test]
    fn verdict_is_admin_only() {
        let (env, mut court) = deploy();
        court.open(
            "d1".to_string(),
            0,
            "b".to_string(),
            "a1".to_string(),
            "r1".to_string(),
        );
        let intruder = env.get_account(1);
        env.set_caller(intruder);
        assert!(court
            .try_issue_verdict("d1".to_string(), 2, U512::from(1u64))
            .is_err());
    }
}
