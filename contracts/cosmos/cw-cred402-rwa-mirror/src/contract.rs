#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Order, Response, StdResult, Uint128,
};
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::msg::{
    AssetResponse, AssetsResponse, ExecuteMsg, InstantiateMsg, QueryMsg,
};
use crate::state::{parse_uaid_asset_type, Config, RwaAsset, ASSETS, CONFIG};

const DEFAULT_LIMIT: u32 = 30;
const MAX_LIMIT: u32 = 100;

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn instantiate(
    deps: DepsMut,
    _env: Env,
    info: MessageInfo,
    msg: InstantiateMsg,
) -> Result<Response, ContractError> {
    if msg.satellite_chain.trim().is_empty() {
        return Err(ContractError::EmptyField {
            field: "satellite_chain".to_string(),
        });
    }
    let admin = match msg.admin {
        Some(a) => deps.api.addr_validate(&a)?,
        None => info.sender.clone(),
    };
    let config = Config {
        admin,
        satellite_chain: msg.satellite_chain,
    };
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("contract", "cw-cred402-rwa-mirror")
        .add_attribute("admin", config.admin.to_string())
        .add_attribute("satellite_chain", config.satellite_chain))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::UpsertAsset {
            uaid,
            jurisdiction,
            issuer_agent_id,
            evidence_digest,
            valuation,
            valuation_asset,
            casper_version,
        } => execute_upsert_asset(
            deps,
            env,
            info,
            uaid,
            jurisdiction,
            issuer_agent_id,
            evidence_digest,
            valuation,
            valuation_asset,
            casper_version,
        ),
        ExecuteMsg::SetAssetActive { uaid, active } => {
            execute_set_active(deps, env, info, uaid, active)
        }
        ExecuteMsg::UpdateAdmin { new_admin } => execute_update_admin(deps, info, new_admin),
    }
}

fn only_admin(deps: &DepsMut, info: &MessageInfo) -> Result<(), ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn execute_upsert_asset(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    uaid: String,
    jurisdiction: String,
    issuer_agent_id: String,
    evidence_digest: String,
    valuation: Uint128,
    valuation_asset: String,
    casper_version: u64,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;

    let asset_type = parse_uaid_asset_type(&uaid).ok_or(ContractError::InvalidUaid {
        uaid: uaid.clone(),
    })?;
    if issuer_agent_id.trim().is_empty() {
        return Err(ContractError::EmptyField {
            field: "issuer_agent_id".to_string(),
        });
    }
    if valuation_asset.trim().is_empty() {
        return Err(ContractError::EmptyField {
            field: "valuation_asset".to_string(),
        });
    }

    // Reject stale (out-of-order) Casper updates.
    let active = match ASSETS.may_load(deps.storage, &uaid)? {
        Some(existing) => {
            if casper_version <= existing.casper_version {
                return Err(ContractError::StaleUpdate {
                    incoming: casper_version,
                    stored: existing.casper_version,
                });
            }
            existing.active
        }
        None => true,
    };

    let asset = RwaAsset {
        uaid: uaid.clone(),
        asset_type,
        jurisdiction,
        issuer_agent_id,
        evidence_digest,
        valuation,
        valuation_asset,
        active,
        casper_version,
        updated_at: env.block.time.seconds(),
    };
    ASSETS.save(deps.storage, &uaid, &asset)?;

    Ok(Response::new()
        .add_attribute("action", "upsert_asset")
        .add_attribute("uaid", uaid)
        .add_attribute("casper_version", casper_version.to_string())
        .add_attribute("valuation", asset.valuation.to_string()))
}

fn execute_set_active(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    uaid: String,
    active: bool,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;
    let existing =
        ASSETS
            .may_load(deps.storage, &uaid)?
            .ok_or(ContractError::AssetNotFound {
                uaid: uaid.clone(),
            })?;
    let updated = RwaAsset {
        active,
        updated_at: env.block.time.seconds(),
        ..existing
    };
    ASSETS.save(deps.storage, &uaid, &updated)?;
    Ok(Response::new()
        .add_attribute("action", "set_asset_active")
        .add_attribute("uaid", uaid)
        .add_attribute("active", active.to_string()))
}

fn execute_update_admin(
    deps: DepsMut,
    info: MessageInfo,
    new_admin: String,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;
    let new_admin = deps.api.addr_validate(&new_admin)?;
    let mut config = CONFIG.load(deps.storage)?;
    config = Config {
        admin: new_admin.clone(),
        ..config
    };
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "update_admin")
        .add_attribute("new_admin", new_admin.to_string()))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Asset { uaid } => {
            let asset = ASSETS.load(deps.storage, &uaid)?;
            to_json_binary(&AssetResponse { asset })
        }
        QueryMsg::Assets { start_after, limit } => {
            to_json_binary(&query_assets(deps, start_after, limit)?)
        }
    }
}

fn query_assets(
    deps: Deps,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<AssetsResponse> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let start = start_after.as_deref().map(Bound::exclusive);
    let assets = ASSETS
        .range(deps.storage, start, None, Order::Ascending)
        .take(limit)
        .map(|item| Ok(item?.1))
        .collect::<StdResult<Vec<_>>>()?;
    Ok(AssetsResponse { assets })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::from_json;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};

    const UAID: &str =
        "uaid:invoice:1111111111111111111111111111111111111111111111111111111111111111";

    fn setup(deps: &mut cosmwasm_std::testing::MockDeps, env: &Env) -> MessageInfo {
        let admin = deps.api.addr_make("admin");
        let info = message_info(&admin, &[]);
        instantiate(
            deps.as_mut(),
            env.clone(),
            info.clone(),
            InstantiateMsg {
                admin: None,
                satellite_chain: "cosmos:cred402-rwa-1".to_string(),
            },
        )
        .unwrap();
        info
    }

    #[test]
    fn upsert_and_version_guard() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let info = setup(&mut deps, &env);

        execute(
            deps.as_mut(),
            env.clone(),
            info.clone(),
            ExecuteMsg::UpsertAsset {
                uaid: UAID.to_string(),
                jurisdiction: "US-DE".to_string(),
                issuer_agent_id: "issuer-agent".to_string(),
                evidence_digest: "0xabc".to_string(),
                valuation: Uint128::new(1_000_000),
                valuation_asset: "USDC".to_string(),
                casper_version: 2,
            },
        )
        .unwrap();

        // Stale update (version 1 <= 2) is rejected.
        let err = execute(
            deps.as_mut(),
            env.clone(),
            info.clone(),
            ExecuteMsg::UpsertAsset {
                uaid: UAID.to_string(),
                jurisdiction: "US-DE".to_string(),
                issuer_agent_id: "issuer-agent".to_string(),
                evidence_digest: "0xabc".to_string(),
                valuation: Uint128::new(999),
                valuation_asset: "USDC".to_string(),
                casper_version: 1,
            },
        )
        .unwrap_err();
        matches!(err, ContractError::StaleUpdate { .. });

        let res = query(
            deps.as_ref(),
            env,
            QueryMsg::Asset {
                uaid: UAID.to_string(),
            },
        )
        .unwrap();
        let parsed: AssetResponse = from_json(res).unwrap();
        assert_eq!(parsed.asset.valuation, Uint128::new(1_000_000));
        assert_eq!(parsed.asset.asset_type, "invoice");
    }

    #[test]
    fn rejects_bad_uaid() {
        let mut deps = mock_dependencies();
        let env = mock_env();
        let info = setup(&mut deps, &env);
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::UpsertAsset {
                uaid: "uaid:invoice:short".to_string(),
                jurisdiction: "US-DE".to_string(),
                issuer_agent_id: "issuer-agent".to_string(),
                evidence_digest: "0xabc".to_string(),
                valuation: Uint128::new(1),
                valuation_asset: "USDC".to_string(),
                casper_version: 1,
            },
        )
        .unwrap_err();
        matches!(err, ContractError::InvalidUaid { .. });
    }
}
