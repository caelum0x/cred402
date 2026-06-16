#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! RWAEvidenceRegistry — hashed evidence about real-world assets, each linked to
//! the x402 receipt that paid for it. Mirrors
//! `lib/ledger/contracts/rwa_evidence_registry.ts`.

extern crate alloc;

use odra::prelude::*;

#[odra::odra_type]
pub struct Evidence {
    pub evidence_id: String,
    pub rwa_id: String,
    pub agent_id: String,
    pub evidence_type: String,
    pub evidence_hash: String,
    pub confidence: u8,
    pub timestamp: u64,
    pub linked_receipt_id: String,
    pub verified: bool,
}

#[odra::event]
pub struct EvidenceSubmitted {
    pub evidence_id: String,
    pub rwa_id: String,
    pub agent_id: String,
    pub evidence_hash: String,
    pub confidence: u8,
    pub linked_receipt_id: String,
}

#[odra::event]
pub struct EvidenceVerified {
    pub evidence_id: String,
    pub rwa_id: String,
}

#[odra::module(events = [EvidenceSubmitted, EvidenceVerified])]
pub struct RWAEvidenceRegistry {
    evidence: Mapping<String, Evidence>,
}

#[odra::module]
impl RWAEvidenceRegistry {
    pub fn init(&mut self) {}

    pub fn submit_evidence(
        &mut self,
        evidence_id: String,
        rwa_id: String,
        agent_id: String,
        evidence_type: String,
        evidence_hash: String,
        confidence: u8,
        linked_receipt_id: String,
    ) {
        let ev = Evidence {
            evidence_id: evidence_id.clone(),
            rwa_id: rwa_id.clone(),
            agent_id: agent_id.clone(),
            evidence_type,
            evidence_hash: evidence_hash.clone(),
            confidence: confidence.min(100),
            timestamp: self.env().get_block_time(),
            linked_receipt_id: linked_receipt_id.clone(),
            verified: false,
        };
        self.evidence.set(&evidence_id, ev);
        self.env().emit_event(EvidenceSubmitted {
            evidence_id,
            rwa_id,
            agent_id,
            evidence_hash,
            confidence: confidence.min(100),
            linked_receipt_id,
        });
    }

    pub fn verify_evidence(&mut self, evidence_id: String) {
        let mut ev = self
            .evidence
            .get(&evidence_id)
            .unwrap_or_revert_with(&self.env(), Error::UnknownEvidence);
        ev.verified = true;
        let rwa_id = ev.rwa_id.clone();
        self.evidence.set(&evidence_id, ev);
        self.env().emit_event(EvidenceVerified {
            evidence_id,
            rwa_id,
        });
    }

    pub fn get_evidence(&self, evidence_id: String) -> Option<Evidence> {
        self.evidence.get(&evidence_id)
    }
}

#[odra::odra_error]
pub enum Error {
    UnknownEvidence = 1,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, RWAEvidenceRegistryHostRef) {
        let env = odra_test::env();
        let reg = RWAEvidenceRegistry::deploy(&env, NoArgs);
        (env, reg)
    }

    #[test]
    fn submits_evidence_linked_to_a_receipt() {
        let (_env, mut reg) = deploy();
        reg.submit_evidence(
            "e1".to_string(),
            "SOLAR-A17".to_string(),
            "a1".to_string(),
            "energy_output".to_string(),
            "0xhash".to_string(),
            92,
            "rcpt-1".to_string(),
        );
        let ev = reg.get_evidence("e1".to_string()).unwrap();
        assert_eq!(ev.rwa_id, "SOLAR-A17");
        assert_eq!(ev.linked_receipt_id, "rcpt-1");
        assert_eq!(ev.confidence, 92);
        assert!(!ev.verified);
    }

    #[test]
    fn confidence_is_clamped_to_100() {
        let (_env, mut reg) = deploy();
        reg.submit_evidence(
            "e1".to_string(),
            "r".to_string(),
            "a1".to_string(),
            "t".to_string(),
            "0x".to_string(),
            250,
            "rcpt-1".to_string(),
        );
        assert_eq!(reg.get_evidence("e1".to_string()).unwrap().confidence, 100);
    }

    #[test]
    fn verify_marks_evidence_and_unknown_reverts() {
        let (_env, mut reg) = deploy();
        reg.submit_evidence(
            "e1".to_string(),
            "r".to_string(),
            "a1".to_string(),
            "t".to_string(),
            "0x".to_string(),
            80,
            "rcpt-1".to_string(),
        );
        reg.verify_evidence("e1".to_string());
        assert!(reg.get_evidence("e1".to_string()).unwrap().verified);
        assert!(reg.try_verify_evidence("missing".to_string()).is_err());
    }
}
