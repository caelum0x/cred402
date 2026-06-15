use cosmwasm_schema::{cw_serde, QueryResponses};

use crate::state::{AgentRecord, BindingRecord, Config};

#[cw_serde]
pub struct InstantiateMsg {
    /// Optional admin override; defaults to the instantiator if `None`.
    pub admin: Option<String>,
    /// CAIP-2 identifier of this satellite chain.
    pub satellite_chain: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Mirror (create or update) a Casper-rooted agent identity onto this chain.
    RegisterAgent {
        /// Full CAID: `cred402:casper:<agent_id>`.
        caid: String,
        /// Casper account public key ("01"+hex ed25519) rooting the agent.
        casper_account: String,
    },
    /// Suspend or reactivate a mirrored agent.
    SetAgentActive { agent_id: String, active: bool },
    /// Mirror an Address-Binding (ABE) result: bind a cosmos address to an agent.
    /// Casper + the external chain already dual-signed the ABE off-chain; this
    /// records the verified outcome so local contracts can resolve identity.
    UpsertBinding {
        agent_id: String,
        cosmos_address: String,
        external_chain: String,
        nonce: String,
        expires_at: u64,
    },
    /// Remove a binding (e.g. on revocation).
    RemoveBinding { agent_id: String },
    /// Transfer registry admin.
    UpdateAdmin { new_admin: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(AgentResponse)]
    Agent { agent_id: String },
    #[returns(BindingResponse)]
    Binding { agent_id: String },
    /// Resolve a cosmos address back to its Casper-rooted agent_id.
    #[returns(AgentByAddressResponse)]
    AgentByAddress { address: String },
    #[returns(AgentsResponse)]
    Agents {
        start_after: Option<String>,
        limit: Option<u32>,
    },
}

#[cw_serde]
pub struct AgentResponse {
    pub agent_id: String,
    pub record: AgentRecord,
}

#[cw_serde]
pub struct BindingResponse {
    pub agent_id: String,
    pub record: BindingRecord,
    /// Whether the binding is currently within its validity window.
    pub valid_now: bool,
}

#[cw_serde]
pub struct AgentByAddressResponse {
    pub agent_id: Option<String>,
}

#[cw_serde]
pub struct AgentsResponse {
    pub agents: Vec<AgentResponse>,
}
