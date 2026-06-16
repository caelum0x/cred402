#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! X402ReceiptRegistry — commitments for x402 machine-to-machine payments. These
//! signed receipts are the verifiable cash-flow proofs the credit policy reads.
//! Mirrors `lib/ledger/contracts/x402_receipt_registry.ts`.

extern crate alloc;

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::odra_type]
pub struct Receipt {
    pub receipt_id: String,
    pub payer_agent: String,
    pub seller_agent: String,
    pub service_type: String,
    pub amount: U512,
    pub timestamp: u64,
    pub rwa_reference_hash: String,
    pub result_hash: String,
    pub payment_proof_hash: String,
    pub dispute_window: u64,
    /// 0 pending, 1 settled, 2 disputed, 3 finalized.
    pub status: u8,
}

#[odra::event]
pub struct ReceiptRecorded {
    pub receipt_id: String,
    pub payer_agent: String,
    pub seller_agent: String,
    pub amount: U512,
    pub result_hash: String,
}

#[odra::event]
pub struct ReceiptFinalized {
    pub receipt_id: String,
}

#[odra::event]
pub struct ReceiptDisputed {
    pub receipt_id: String,
    pub dispute_hash: String,
}

#[odra::module(events = [ReceiptRecorded, ReceiptFinalized, ReceiptDisputed])]
pub struct X402ReceiptRegistry {
    receipts: Mapping<String, Receipt>,
    /// Replay protection: `${payer}:${nonce}` -> used, and proof-hash -> used.
    used_nonces: Mapping<String, bool>,
    used_proofs: Mapping<String, bool>,
    count: Var<u64>,
}

#[odra::module]
impl X402ReceiptRegistry {
    pub fn init(&mut self) {
        self.count.set(0);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn record_receipt(
        &mut self,
        receipt_id: String,
        payer_agent: String,
        seller_agent: String,
        service_type: String,
        amount: U512,
        rwa_reference_hash: String,
        result_hash: String,
        payment_proof_hash: String,
        nonce: String,
        expires_at: u64,
        dispute_window: u64,
    ) {
        if self.receipts.get(&receipt_id).is_some() {
            self.env().revert(Error::DuplicateReceipt);
        }
        // Replay protection (p2 §6.3): nonce unique per payer, proof unique, not expired.
        if self.env().get_block_time() > expires_at {
            self.env().revert(Error::ProofExpired);
        }
        let nonce_key = format!("{}:{}", payer_agent, nonce);
        if self.used_nonces.get(&nonce_key).unwrap_or(false) {
            self.env().revert(Error::NonceReplay);
        }
        if self.used_proofs.get(&payment_proof_hash).unwrap_or(false) {
            self.env().revert(Error::ProofReplay);
        }
        self.used_nonces.set(&nonce_key, true);
        self.used_proofs.set(&payment_proof_hash, true);
        let receipt = Receipt {
            receipt_id: receipt_id.clone(),
            payer_agent: payer_agent.clone(),
            seller_agent: seller_agent.clone(),
            service_type,
            amount,
            timestamp: self.env().get_block_time(),
            rwa_reference_hash,
            result_hash: result_hash.clone(),
            payment_proof_hash,
            dispute_window,
            status: 0,
        };
        self.receipts.set(&receipt_id, receipt);
        self.count.set(self.count.get_or_default() + 1);
        self.env().emit_event(ReceiptRecorded {
            receipt_id,
            payer_agent,
            seller_agent,
            amount,
            result_hash,
        });
    }

    pub fn settle_receipt(&mut self, receipt_id: String) {
        let mut r = self.must(&receipt_id);
        if r.status == 0 {
            r.status = 1;
            self.receipts.set(&receipt_id, r);
        }
    }

    pub fn finalize_receipt(&mut self, receipt_id: String) {
        let mut r = self.must(&receipt_id);
        if r.status == 2 {
            self.env().revert(Error::ReceiptDisputed);
        }
        r.status = 3;
        self.receipts.set(&receipt_id, r);
        self.env().emit_event(ReceiptFinalized { receipt_id });
    }

    pub fn dispute_receipt(&mut self, receipt_id: String, dispute_hash: String) {
        let mut r = self.must(&receipt_id);
        r.status = 2;
        self.receipts.set(&receipt_id, r);
        self.env().emit_event(ReceiptDisputed {
            receipt_id,
            dispute_hash,
        });
    }

    pub fn get_receipt(&self, receipt_id: String) -> Option<Receipt> {
        self.receipts.get(&receipt_id)
    }

    pub fn total(&self) -> u64 {
        self.count.get_or_default()
    }

    fn must(&self, receipt_id: &str) -> Receipt {
        self.receipts
            .get(&receipt_id.to_string())
            .unwrap_or_revert_with(&self.env(), Error::UnknownReceipt)
    }
}

#[odra::odra_error]
pub enum Error {
    DuplicateReceipt = 1,
    UnknownReceipt = 2,
    ReceiptDisputed = 3,
    ProofExpired = 4,
    NonceReplay = 5,
    ProofReplay = 6,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, X402ReceiptRegistryHostRef) {
        let env = odra_test::env();
        let reg = X402ReceiptRegistry::deploy(&env, NoArgs);
        (env, reg)
    }

    #[allow(clippy::too_many_arguments)]
    fn record(reg: &mut X402ReceiptRegistryHostRef, id: &str, nonce: &str, proof: &str) {
        reg.record_receipt(
            id.to_string(),
            "payer".to_string(),
            "seller".to_string(),
            "rwa.energy".to_string(),
            U512::from(2_000_000u64),
            "0xrwa".to_string(),
            "0xresult".to_string(),
            proof.to_string(),
            nonce.to_string(),
            u64::MAX,
            86_400,
        );
    }

    #[test]
    fn records_and_finalizes_a_receipt() {
        let (_env, mut reg) = deploy();
        record(&mut reg, "r1", "n1", "p1");
        assert_eq!(reg.total(), 1);
        assert_eq!(reg.get_receipt("r1".to_string()).unwrap().status, 0);
        reg.finalize_receipt("r1".to_string());
        assert_eq!(reg.get_receipt("r1".to_string()).unwrap().status, 3);
    }

    #[test]
    fn rejects_nonce_and_proof_replay() {
        let (_env, mut reg) = deploy();
        record(&mut reg, "r1", "n1", "p1");
        // same payer+nonce replay
        assert!(reg
            .try_record_receipt(
                "r2".to_string(),
                "payer".to_string(),
                "seller".to_string(),
                "svc".to_string(),
                U512::from(1u64),
                "0x".to_string(),
                "0x".to_string(),
                "p2".to_string(),
                "n1".to_string(),
                u64::MAX,
                1,
            )
            .is_err());
        // same proof hash replay
        assert!(reg
            .try_record_receipt(
                "r3".to_string(),
                "payer".to_string(),
                "seller".to_string(),
                "svc".to_string(),
                U512::from(1u64),
                "0x".to_string(),
                "0x".to_string(),
                "p1".to_string(),
                "n2".to_string(),
                u64::MAX,
                1,
            )
            .is_err());
    }

    #[test]
    fn rejects_expired_proof() {
        let (env, mut reg) = deploy();
        env.advance_block_time(1000);
        let expired = reg.try_record_receipt(
            "r1".to_string(),
            "payer".to_string(),
            "seller".to_string(),
            "svc".to_string(),
            U512::from(1u64),
            "0x".to_string(),
            "0x".to_string(),
            "p1".to_string(),
            "n1".to_string(),
            500,
            1,
        );
        assert!(expired.is_err());
    }

    #[test]
    fn disputed_receipt_cannot_be_finalized() {
        let (_env, mut reg) = deploy();
        record(&mut reg, "r1", "n1", "p1");
        reg.dispute_receipt("r1".to_string(), "0xdispute".to_string());
        assert_eq!(reg.get_receipt("r1".to_string()).unwrap().status, 2);
        assert!(reg.try_finalize_receipt("r1".to_string()).is_err());
    }
}
