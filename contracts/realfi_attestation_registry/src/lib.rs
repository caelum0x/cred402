//! RealFiAttestationRegistry (p6) — a generic registry for any off-chain finance
//! evidence (Plaid bank verification, payout confirmations, chargeback signals,
//! sanctions clearance, accounting audits). Everything is a hash + status +
//! provider; underwriting reads these as ADDITIONAL signals, never as a
//! replacement for Casper-native receipts. Mirrors
//! `lib/ledger/contracts/realfi_attestation_registry.ts`.

use odra::prelude::*;

#[odra::odra_type]
pub struct RealFiAttestation {
    pub attestation_id: String,
    /// e.g. "bank_verification", "chargeback_signal", "sanctions_clearance".
    pub attestation_type: String,
    pub subject_id: String,
    pub provider: String,
    pub attestation_hash: String,
    /// 0 active, 1 revoked.
    pub status: u8,
    pub created_at: u64,
    pub expires_at: u64,
}

#[odra::event]
pub struct RealFiAttestationRecorded {
    pub attestation_id: String,
    pub attestation_type: String,
    pub subject_id: String,
    pub provider: String,
}

#[odra::event]
pub struct RealFiAttestationRevoked {
    pub attestation_id: String,
    pub reason_hash: String,
}

#[odra::module(events = [RealFiAttestationRecorded, RealFiAttestationRevoked])]
pub struct RealFiAttestationRegistry {
    attestations: Mapping<String, RealFiAttestation>,
}

#[odra::module]
impl RealFiAttestationRegistry {
    pub fn init(&mut self) {}

    pub fn record_attestation(
        &mut self,
        attestation_id: String,
        attestation_type: String,
        subject_id: String,
        provider: String,
        attestation_hash: String,
        expires_at: u64,
    ) {
        if self.attestations.get(&attestation_id).is_some() {
            self.env().revert(Error::DuplicateAttestation);
        }
        if expires_at <= self.env().get_block_time() {
            self.env().revert(Error::Expired);
        }
        let record = RealFiAttestation {
            attestation_id: attestation_id.clone(),
            attestation_type: attestation_type.clone(),
            subject_id: subject_id.clone(),
            provider: provider.clone(),
            attestation_hash,
            status: 0,
            created_at: self.env().get_block_time(),
            expires_at,
        };
        self.attestations.set(&attestation_id, record);
        self.env().emit_event(RealFiAttestationRecorded {
            attestation_id,
            attestation_type,
            subject_id,
            provider,
        });
    }

    pub fn revoke_attestation(&mut self, attestation_id: String, reason_hash: String) {
        if let Some(mut a) = self.attestations.get(&attestation_id) {
            a.status = 1;
            self.attestations.set(&attestation_id, a);
            self.env().emit_event(RealFiAttestationRevoked {
                attestation_id,
                reason_hash,
            });
        }
    }

    pub fn get_attestation(&self, attestation_id: String) -> Option<RealFiAttestation> {
        self.attestations.get(&attestation_id)
    }
}

#[odra::odra_error]
pub enum Error {
    DuplicateAttestation = 1,
    Expired = 2,
}
