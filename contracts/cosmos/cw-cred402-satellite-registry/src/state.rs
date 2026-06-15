use cosmwasm_schema::cw_serde;
use cosmwasm_std::Addr;
use cw_storage_plus::{Item, Map};

/// Global registry configuration.
#[cw_serde]
pub struct Config {
    /// Admin authorized to register agents and bindings (typically the
    /// cosmos<->casper relayer account that anchors Casper identity state here).
    pub admin: Addr,
    /// CAIP-2 identifier of this satellite chain, e.g. "cosmos:cred402-rwa-1".
    pub satellite_chain: String,
}

/// A Casper-rooted agent identity mirrored onto this satellite.
///
/// `caid` is always of the form `cred402:casper:<agent_id>` — Casper is the
/// canonical identity root; this record is a read-optimized mirror.
#[cw_serde]
pub struct AgentRecord {
    /// Full CAID string: `cred402:casper:<agent_id>`.
    pub caid: String,
    /// The Casper account public key ("01"+hex ed25519) that roots this agent.
    pub casper_account: String,
    /// Whether the agent is active (can be suspended without deletion).
    pub active: bool,
    /// Block time (seconds) when this record was last mirrored.
    pub updated_at: u64,
}

/// The local Address-Binding (ABE) mirror: which cosmos address an agent
/// controls on this chain, and until when the Casper-rooted binding is valid.
#[cw_serde]
pub struct BindingRecord {
    /// The cosmos bech32 address bound to the agent on this chain.
    pub cosmos_address: Addr,
    /// CAIP-2 external chain identifier from the ABE (this satellite).
    pub external_chain: String,
    /// Binding nonce from the ABE (for audit / replay correlation).
    pub nonce: String,
    /// Unix seconds at which the Casper-rooted binding expires.
    pub expires_at: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");

/// agent_id -> AgentRecord
pub const AGENTS: Map<&str, AgentRecord> = Map::new("agents");

/// agent_id -> BindingRecord (the agent's cosmos address binding on this chain)
pub const BINDINGS: Map<&str, BindingRecord> = Map::new("bindings");

/// Reverse index: cosmos address -> agent_id, so local contracts can resolve a
/// caller back to its Casper-rooted agent identity.
pub const ADDRESS_TO_AGENT: Map<&Addr, String> = Map::new("address_to_agent");

/// Parse and validate a CAID of the form `cred402:casper:<agent_id>`,
/// returning the `<agent_id>` segment. Mirrors `parseCaid` semantics but is
/// strict about the `casper` root because every agent is rooted on Casper.
pub fn parse_caid_agent_id(caid: &str) -> Option<String> {
    let rest = caid.strip_prefix("cred402:")?;
    let (chain, agent_id) = rest.split_once(':')?;
    if chain != "casper" {
        return None;
    }
    if agent_id.is_empty() {
        return None;
    }
    Some(agent_id.to_string())
}
