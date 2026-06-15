use cosmwasm_schema::{cw_serde, QueryResponses};

use crate::state::{Config, StoredReceipt, UniversalReceiptEnvelope};

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: Option<String>,
    /// CAIP-2 identifier of this satellite chain (default `origin_chain`).
    pub origin_chain: String,
    /// Human network name recorded as `settlement_network`.
    pub settlement_network: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Record a locally-settled x402 payment. The contract recomputes
    /// `receipt_id = blake2b256(canonical_json(URE))`; if `claimed_receipt_id`
    /// is provided it must match (mirrors `verifyUniversalReceipt`).
    SettleReceipt {
        envelope: UniversalReceiptEnvelope,
        claimed_receipt_id: Option<String>,
    },
    /// Relayer acknowledges a receipt has been anchored on Casper.
    MarkAnchored { receipt_id: String },
    UpdateAdmin { new_admin: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(ReceiptResponse)]
    Receipt { receipt_id: String },
    /// Pending (unanchored) outbox entries for the relayer, ordered by sequence.
    #[returns(OutboxResponse)]
    PendingOutbox {
        start_after: Option<u64>,
        limit: Option<u32>,
    },
    /// Pure function: compute the canonical receipt_id for an envelope without
    /// storing it. Useful for clients building receipts off-chain.
    #[returns(ComputeIdResponse)]
    ComputeReceiptId { envelope: UniversalReceiptEnvelope },
}

#[cw_serde]
pub struct ReceiptResponse {
    pub receipt: StoredReceipt,
}

#[cw_serde]
pub struct OutboxResponse {
    pub entries: Vec<StoredReceipt>,
}

#[cw_serde]
pub struct ComputeIdResponse {
    pub receipt_id: String,
}
