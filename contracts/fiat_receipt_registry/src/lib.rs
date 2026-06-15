//! FiatReceiptRegistry (p6) — the Stripe-equivalent of the x402 receipt registry.
//! Records privacy-preserving Fiat Receipt Envelope commitments so fiat revenue
//! counts toward agent credit WITHOUT putting PII on-chain. Mirrors
//! `lib/ledger/contracts/fiat_receipt_registry.ts`.

use odra::prelude::*;

#[odra::odra_type]
pub struct FiatReceipt {
    pub receipt_id: String,
    pub provider: String,
    pub seller_agent: String,
    pub operator_id: String,
    pub amount: String,
    pub currency: String,
    pub service_type: String,
    pub provider_receipt_hash: String,
    pub result_hash: String,
    /// 0 pending, 1 settled, 2 refunded, 3 disputed, 4 finalized.
    pub status: u8,
    pub recorded_at: u64,
}

#[odra::event]
pub struct FiatReceiptRecorded {
    pub receipt_id: String,
    pub provider: String,
    pub seller_agent: String,
    pub currency: String,
    pub service_type: String,
}

#[odra::event]
pub struct FiatReceiptFinalized {
    pub receipt_id: String,
}

#[odra::event]
pub struct FiatReceiptDisputed {
    pub receipt_id: String,
    pub reason_hash: String,
}

#[odra::module(events = [FiatReceiptRecorded, FiatReceiptFinalized, FiatReceiptDisputed])]
pub struct FiatReceiptRegistry {
    receipts: Mapping<String, FiatReceipt>,
    /// `${provider}:${event_id_hash}` -> used (one provider event = one receipt).
    used_provider_events: Mapping<String, bool>,
}

#[odra::module]
impl FiatReceiptRegistry {
    pub fn init(&mut self) {}

    #[allow(clippy::too_many_arguments)]
    pub fn record_fiat_receipt(
        &mut self,
        receipt_id: String,
        provider: String,
        seller_agent: String,
        operator_id: String,
        amount: String,
        currency: String,
        service_type: String,
        provider_event_id_hash: String,
        provider_receipt_hash: String,
        result_hash: String,
        settlement_status: u8,
    ) {
        if self.receipts.get(&receipt_id).is_some() {
            self.env().revert(Error::DuplicateReceipt);
        }
        let event_key = format!("{}:{}", provider, provider_event_id_hash);
        if self.used_provider_events.get(&event_key).unwrap_or(false) {
            self.env().revert(Error::ProviderEventReplay);
        }
        self.used_provider_events.set(&event_key, true);
        let receipt = FiatReceipt {
            receipt_id: receipt_id.clone(),
            provider: provider.clone(),
            seller_agent: seller_agent.clone(),
            operator_id,
            amount,
            currency: currency.clone(),
            service_type: service_type.clone(),
            provider_receipt_hash,
            result_hash,
            status: settlement_status,
            recorded_at: self.env().get_block_time(),
        };
        self.receipts.set(&receipt_id, receipt);
        self.env().emit_event(FiatReceiptRecorded {
            receipt_id,
            provider,
            seller_agent,
            currency,
            service_type,
        });
    }

    pub fn finalize_fiat_receipt(&mut self, receipt_id: String) {
        let mut r = self.must(&receipt_id);
        if r.status == 3 {
            self.env().revert(Error::ReceiptDisputed);
        }
        r.status = 4;
        self.receipts.set(&receipt_id, r);
        self.env().emit_event(FiatReceiptFinalized { receipt_id });
    }

    pub fn dispute_fiat_receipt(&mut self, receipt_id: String, reason_hash: String) {
        let mut r = self.must(&receipt_id);
        r.status = 3;
        self.receipts.set(&receipt_id, r);
        self.env().emit_event(FiatReceiptDisputed {
            receipt_id,
            reason_hash,
        });
    }

    pub fn get_fiat_receipt(&self, receipt_id: String) -> Option<FiatReceipt> {
        self.receipts.get(&receipt_id)
    }

    fn must(&self, receipt_id: &str) -> FiatReceipt {
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
    ProviderEventReplay = 4,
}
