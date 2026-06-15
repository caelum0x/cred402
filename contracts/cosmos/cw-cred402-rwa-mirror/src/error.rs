use cosmwasm_std::StdError;
use thiserror::Error;

/// Errors for the Cred402 Cosmos RWA mirror.
#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("unauthorized: only the mirror admin may update Casper-rooted RWA state")]
    Unauthorized {},

    #[error("invalid UAID: {uaid} (expected `uaid:<asset_type>:<64-hex>`)")]
    InvalidUaid { uaid: String },

    #[error("asset {uaid} not mirrored on this satellite")]
    AssetNotFound { uaid: String },

    #[error("stale update: incoming casper_version {incoming} <= stored {stored}")]
    StaleUpdate { incoming: u64, stored: u64 },

    #[error("empty value not allowed for field `{field}`")]
    EmptyField { field: String },
}
