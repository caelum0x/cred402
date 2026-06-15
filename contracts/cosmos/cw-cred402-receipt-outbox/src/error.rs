use cosmwasm_std::StdError;
use thiserror::Error;

/// Errors for the Cred402 Cosmos receipt outbox.
#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("unauthorized")]
    Unauthorized {},

    #[error("wrong receipt type: expected Cred402Receipt")]
    WrongType {},

    #[error("missing required field `{field}`")]
    MissingField { field: String },

    #[error("amount must be a base-10 integer string (smallest units), got `{amount}`")]
    InvalidAmount { amount: String },

    #[error("receipt_id mismatch: claimed `{claimed}`, computed `{computed}`")]
    ReceiptIdMismatch { claimed: String, computed: String },

    #[error("receipt {receipt_id} already recorded")]
    DuplicateReceipt { receipt_id: String },
}
