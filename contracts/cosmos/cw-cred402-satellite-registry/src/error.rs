use cosmwasm_std::StdError;
use thiserror::Error;

/// Errors for the Cred402 Cosmos satellite registry.
#[derive(Error, Debug, PartialEq)]
pub enum ContractError {
    #[error("{0}")]
    Std(#[from] StdError),

    #[error("unauthorized: only the registry admin may perform this action")]
    Unauthorized {},

    #[error("invalid CAID: {caid} (expected `cred402:casper:<agent_id>`)")]
    InvalidCaid { caid: String },

    #[error("agent {agent_id} is not registered on this satellite")]
    AgentNotFound { agent_id: String },

    #[error("binding for agent {agent_id} not found")]
    BindingNotFound { agent_id: String },

    #[error("address binding has expired (expires_at={expires_at}, now={now})")]
    BindingExpired { expires_at: u64, now: u64 },

    #[error("empty value not allowed for field `{field}`")]
    EmptyField { field: String },
}
