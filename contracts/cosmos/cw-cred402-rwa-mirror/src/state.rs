use cosmwasm_schema::cw_serde;
use cosmwasm_std::{Addr, Uint128};
use cw_storage_plus::{Item, Map};

#[cw_serde]
pub struct Config {
    /// Admin authorized to mirror Casper RWA state (the relayer account).
    pub admin: Addr,
    /// CAIP-2 identifier of this satellite chain.
    pub satellite_chain: String,
}

/// A Real-World Asset mirrored from the Casper RWA registry. Casper holds the
/// canonical evidence graph; this is the read model an appchain RWA market uses.
#[cw_serde]
pub struct RwaAsset {
    /// Universal Asset ID: `uaid:<asset_type>:<blake2b256(...)>`.
    pub uaid: String,
    /// Asset class (matches the `<asset_type>` segment of the UAID).
    pub asset_type: String,
    /// Jurisdiction code from the canonical UAID inputs.
    pub jurisdiction: String,
    /// Casper-rooted agent_id of the issuing/attesting agent.
    pub issuer_agent_id: String,
    /// blake2b-256 digest (0x-hex) of the latest Casper-attested evidence bundle.
    pub evidence_digest: String,
    /// Latest Casper-attested valuation, in smallest units of `valuation_asset`.
    pub valuation: Uint128,
    /// Settlement asset for the valuation (e.g. "USDC").
    pub valuation_asset: String,
    /// Whether the asset is currently tradeable on this appchain.
    pub active: bool,
    /// Monotonic version from Casper; rejects out-of-order mirror updates.
    pub casper_version: u64,
    /// Block time (seconds) of the last mirror update on this chain.
    pub updated_at: u64,
}

pub const CONFIG: Item<Config> = Item::new("config");

/// uaid -> RwaAsset
pub const ASSETS: Map<&str, RwaAsset> = Map::new("assets");

/// Validate a UAID of the form `uaid:<asset_type>:<64 lowercase hex>` and return
/// the `<asset_type>` segment. Mirrors `parseUaid` from the TS standards.
pub fn parse_uaid_asset_type(uaid: &str) -> Option<String> {
    let rest = uaid.strip_prefix("uaid:")?;
    let (asset_type, digest) = rest.split_once(':')?;
    if asset_type.is_empty() {
        return None;
    }
    // asset_type allows [a-z0-9_-]
    if !asset_type
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
    {
        return None;
    }
    if digest.len() != 64 || !digest.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    Some(asset_type.to_string())
}
