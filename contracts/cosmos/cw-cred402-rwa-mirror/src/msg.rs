use cosmwasm_schema::{cw_serde, QueryResponses};
use cosmwasm_std::Uint128;

use crate::state::{Config, RwaAsset};

#[cw_serde]
pub struct InstantiateMsg {
    pub admin: Option<String>,
    pub satellite_chain: String,
}

#[cw_serde]
pub enum ExecuteMsg {
    /// Mirror (create or update) a Casper-attested RWA onto this appchain.
    /// Updates are accepted only if `casper_version` strictly increases.
    UpsertAsset {
        uaid: String,
        jurisdiction: String,
        issuer_agent_id: String,
        evidence_digest: String,
        valuation: Uint128,
        valuation_asset: String,
        casper_version: u64,
    },
    /// Activate / deactivate trading of a mirrored asset locally.
    SetAssetActive { uaid: String, active: bool },
    UpdateAdmin { new_admin: String },
}

#[cw_serde]
#[derive(QueryResponses)]
pub enum QueryMsg {
    #[returns(Config)]
    Config {},
    #[returns(AssetResponse)]
    Asset { uaid: String },
    #[returns(AssetsResponse)]
    Assets {
        start_after: Option<String>,
        limit: Option<u32>,
    },
}

#[cw_serde]
pub struct AssetResponse {
    pub asset: RwaAsset,
}

#[cw_serde]
pub struct AssetsResponse {
    pub assets: Vec<RwaAsset>,
}
