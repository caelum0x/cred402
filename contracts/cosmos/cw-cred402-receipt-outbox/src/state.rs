use cosmwasm_schema::cw_serde;
use cosmwasm_std::Addr;
use cw_storage_plus::{Item, Map};

use crate::canonical::CanonValue;

/// Outbox configuration.
#[cw_serde]
pub struct Config {
    /// Admin (can pause / rotate relayer authorization).
    pub admin: Addr,
    /// CAIP-2 identifier of this satellite chain, used as the default
    /// `origin_chain` sanity check for locally-settled receipts.
    pub origin_chain: String,
    /// Human network name (e.g. "cred402-rwa-1"), recorded as settlement_network.
    pub settlement_network: String,
    /// Monotonic counter of receipts emitted (also used as the outbox sequence).
    pub sequence: u64,
}

/// The Universal Receipt Envelope (URE) — field-for-field identical to the
/// TypeScript `UniversalReceiptEnvelope`. `type` and `version` are fixed.
#[cw_serde]
pub struct UniversalReceiptEnvelope {
    pub origin_chain: String,
    pub settlement_network: String,
    pub payer_agent_id: String,
    pub seller_agent_id: String,
    pub payer_address: String,
    pub seller_address: String,
    pub asset: String,
    /// Smallest-unit integer as a string.
    pub amount: String,
    pub service_type: String,
    pub request_hash: String,
    pub result_hash: String,
    pub payment_proof_hash: String,
    pub settlement_tx_hash: String,
    pub nonce: String,
    pub created_at: u64,
}

pub const RECEIPT_TYPE: &str = "Cred402Receipt";
pub const RECEIPT_VERSION: &str = "1";

impl UniversalReceiptEnvelope {
    /// Build the canonical value with the fixed `type`/`version` envelope keys,
    /// exactly as the TS `buildUniversalReceipt` does before hashing.
    pub fn to_canonical(&self) -> CanonValue {
        CanonValue::obj(vec![
            ("type", CanonValue::str(RECEIPT_TYPE)),
            ("version", CanonValue::str(RECEIPT_VERSION)),
            ("origin_chain", CanonValue::str(self.origin_chain.clone())),
            (
                "settlement_network",
                CanonValue::str(self.settlement_network.clone()),
            ),
            (
                "payer_agent_id",
                CanonValue::str(self.payer_agent_id.clone()),
            ),
            (
                "seller_agent_id",
                CanonValue::str(self.seller_agent_id.clone()),
            ),
            ("payer_address", CanonValue::str(self.payer_address.clone())),
            (
                "seller_address",
                CanonValue::str(self.seller_address.clone()),
            ),
            ("asset", CanonValue::str(self.asset.clone())),
            ("amount", CanonValue::str(self.amount.clone())),
            ("service_type", CanonValue::str(self.service_type.clone())),
            ("request_hash", CanonValue::str(self.request_hash.clone())),
            ("result_hash", CanonValue::str(self.result_hash.clone())),
            (
                "payment_proof_hash",
                CanonValue::str(self.payment_proof_hash.clone()),
            ),
            (
                "settlement_tx_hash",
                CanonValue::str(self.settlement_tx_hash.clone()),
            ),
            ("nonce", CanonValue::str(self.nonce.clone())),
            ("created_at", CanonValue::int(self.created_at as i128)),
        ])
    }
}

/// A persisted receipt awaiting (or having completed) anchoring to Casper.
#[cw_serde]
pub struct StoredReceipt {
    pub envelope: UniversalReceiptEnvelope,
    pub receipt_id: String,
    /// Outbox sequence number for the relayer.
    pub sequence: u64,
    /// Whether the cosmos->casper relayer has acknowledged anchoring.
    pub anchored: bool,
}

pub const CONFIG: Item<Config> = Item::new("config");

/// receipt_id -> StoredReceipt
pub const RECEIPTS: Map<&str, StoredReceipt> = Map::new("receipts");

/// sequence -> receipt_id (ordered outbox the relayer drains)
pub const OUTBOX: Map<u64, String> = Map::new("outbox");
