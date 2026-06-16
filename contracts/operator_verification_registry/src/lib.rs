#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! OperatorVerificationRegistry (p6) — links a real-world business/operator to an
//! agent via a Stripe-Identity-style attestation, on-chain as hashes only. A
//! verified operator strengthens credit underwriting but never replaces
//! Casper-native receipt history. Mirrors
//! `lib/ledger/contracts/operator_verification_registry.ts`.

extern crate alloc;

use odra::prelude::*;

#[odra::odra_type]
pub struct OperatorVerification {
    pub operator_id: String,
    pub provider: String,
    /// 0 unverified, 1 email, 2 business, 3 regulated.
    pub verification_level: u8,
    pub jurisdiction: String,
    /// 0 pending, 1 verified, 2 rejected, 3 revoked.
    pub status: u8,
    pub attestation_hash: String,
    pub verified_at: u64,
    pub expires_at: u64,
}

#[odra::event]
pub struct OperatorVerified {
    pub operator_id: String,
    pub provider: String,
    pub verification_level: u8,
    pub jurisdiction: String,
}

#[odra::event]
pub struct OperatorVerificationRevoked {
    pub operator_id: String,
    pub reason_hash: String,
}

#[odra::module(events = [OperatorVerified, OperatorVerificationRevoked])]
pub struct OperatorVerificationRegistry {
    verifications: Mapping<String, OperatorVerification>,
}

#[odra::module]
impl OperatorVerificationRegistry {
    pub fn init(&mut self) {}

    #[allow(clippy::too_many_arguments)]
    pub fn record_operator_verification(
        &mut self,
        operator_id: String,
        provider: String,
        verification_level: u8,
        jurisdiction: String,
        status: u8,
        attestation_hash: String,
        expires_at: u64,
    ) {
        if expires_at <= self.env().get_block_time() {
            self.env().revert(Error::Expired);
        }
        let record = OperatorVerification {
            operator_id: operator_id.clone(),
            provider: provider.clone(),
            verification_level,
            jurisdiction: jurisdiction.clone(),
            status,
            attestation_hash,
            verified_at: self.env().get_block_time(),
            expires_at,
        };
        self.verifications.set(&operator_id, record);
        self.env().emit_event(OperatorVerified {
            operator_id,
            provider,
            verification_level,
            jurisdiction,
        });
    }

    pub fn revoke_operator_verification(&mut self, operator_id: String, reason_hash: String) {
        if let Some(mut v) = self.verifications.get(&operator_id) {
            v.status = 3;
            self.verifications.set(&operator_id, v);
            self.env().emit_event(OperatorVerificationRevoked {
                operator_id,
                reason_hash,
            });
        }
    }

    pub fn get_operator_verification(&self, operator_id: String) -> Option<OperatorVerification> {
        self.verifications.get(&operator_id)
    }

    /// Currently verified = status verified (1) and not expired.
    pub fn is_verified(&self, operator_id: String) -> bool {
        match self.verifications.get(&operator_id) {
            Some(v) => v.status == 1 && v.expires_at > self.env().get_block_time(),
            None => false,
        }
    }
}

#[odra::odra_error]
pub enum Error {
    Expired = 1,
}
