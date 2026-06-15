#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, Addr, Binary, Deps, DepsMut, Env, MessageInfo, Order, Response, StdResult,
};
use cw_storage_plus::Bound;

use crate::error::ContractError;
use crate::msg::{
    AgentByAddressResponse, AgentResponse, AgentsResponse, BindingResponse, ExecuteMsg,
    InstantiateMsg, QueryMsg,
};
use crate::state::{
    parse_caid_agent_id, AgentRecord, BindingRecord, Config, ADDRESS_TO_AGENT, AGENTS, BINDINGS,
    CONFIG,
};

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
        .add_attribute("contract", "cw-cred402-satellite-registry")
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
        ExecuteMsg::RegisterAgent {
            caid,
            casper_account,
        } => execute_register_agent(deps, env, info, caid, casper_account),
        ExecuteMsg::SetAgentActive { agent_id, active } => {
            execute_set_agent_active(deps, env, info, agent_id, active)
        }
        ExecuteMsg::UpsertBinding {
            agent_id,
            cosmos_address,
            external_chain,
            nonce,
            expires_at,
        } => execute_upsert_binding(
            deps,
            info,
            agent_id,
            cosmos_address,
            external_chain,
            nonce,
            expires_at,
        ),
        ExecuteMsg::RemoveBinding { agent_id } => execute_remove_binding(deps, info, agent_id),
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

fn execute_register_agent(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    caid: String,
    casper_account: String,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;

    let agent_id = parse_caid_agent_id(&caid).ok_or(ContractError::InvalidCaid {
        caid: caid.clone(),
    })?;
    if casper_account.trim().is_empty() {
        return Err(ContractError::EmptyField {
            field: "casper_account".to_string(),
        });
    }

    let record = AgentRecord {
        caid,
        casper_account,
        active: true,
        updated_at: env.block.time.seconds(),
    };
    AGENTS.save(deps.storage, &agent_id, &record)?;

    Ok(Response::new()
        .add_attribute("action", "register_agent")
        .add_attribute("agent_id", agent_id)
        .add_attribute("casper_account", record.casper_account))
}

fn execute_set_agent_active(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    agent_id: String,
    active: bool,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;

    let mut record = AGENTS
        .may_load(deps.storage, &agent_id)?
        .ok_or(ContractError::AgentNotFound {
            agent_id: agent_id.clone(),
        })?;
    let updated = AgentRecord {
        active,
        updated_at: env.block.time.seconds(),
        ..record.clone()
    };
    record = updated;
    AGENTS.save(deps.storage, &agent_id, &record)?;

    Ok(Response::new()
        .add_attribute("action", "set_agent_active")
        .add_attribute("agent_id", agent_id)
        .add_attribute("active", active.to_string()))
}

#[allow(clippy::too_many_arguments)]
fn execute_upsert_binding(
    deps: DepsMut,
    info: MessageInfo,
    agent_id: String,
    cosmos_address: String,
    external_chain: String,
    nonce: String,
    expires_at: u64,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;

    // Agent must already be mirrored on this satellite.
    if !AGENTS.has(deps.storage, &agent_id) {
        return Err(ContractError::AgentNotFound {
            agent_id: agent_id.clone(),
        });
    }
    if external_chain.trim().is_empty() {
        return Err(ContractError::EmptyField {
            field: "external_chain".to_string(),
        });
    }
    let addr: Addr = deps.api.addr_validate(&cosmos_address)?;

    // If an old binding pointed at a different address, drop the stale reverse index.
    if let Some(prev) = BINDINGS.may_load(deps.storage, &agent_id)? {
        if prev.cosmos_address != addr {
            ADDRESS_TO_AGENT.remove(deps.storage, &prev.cosmos_address);
        }
    }

    let record = BindingRecord {
        cosmos_address: addr.clone(),
        external_chain,
        nonce,
        expires_at,
    };
    BINDINGS.save(deps.storage, &agent_id, &record)?;
    ADDRESS_TO_AGENT.save(deps.storage, &addr, &agent_id)?;

    Ok(Response::new()
        .add_attribute("action", "upsert_binding")
        .add_attribute("agent_id", agent_id)
        .add_attribute("cosmos_address", addr.to_string())
        .add_attribute("expires_at", record.expires_at.to_string()))
}

fn execute_remove_binding(
    deps: DepsMut,
    info: MessageInfo,
    agent_id: String,
) -> Result<Response, ContractError> {
    only_admin(&deps, &info)?;

    let record =
        BINDINGS
            .may_load(deps.storage, &agent_id)?
            .ok_or(ContractError::BindingNotFound {
                agent_id: agent_id.clone(),
            })?;
    ADDRESS_TO_AGENT.remove(deps.storage, &record.cosmos_address);
    BINDINGS.remove(deps.storage, &agent_id);

    Ok(Response::new()
        .add_attribute("action", "remove_binding")
        .add_attribute("agent_id", agent_id))
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
pub fn query(deps: Deps, env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Agent { agent_id } => to_json_binary(&query_agent(deps, agent_id)?),
        QueryMsg::Binding { agent_id } => to_json_binary(&query_binding(deps, env, agent_id)?),
        QueryMsg::AgentByAddress { address } => {
            to_json_binary(&query_agent_by_address(deps, address)?)
        }
        QueryMsg::Agents { start_after, limit } => {
            to_json_binary(&query_agents(deps, start_after, limit)?)
        }
    }
}

fn query_agent(deps: Deps, agent_id: String) -> StdResult<AgentResponse> {
    let record = AGENTS.load(deps.storage, &agent_id)?;
    Ok(AgentResponse { agent_id, record })
}

fn query_binding(deps: Deps, env: Env, agent_id: String) -> StdResult<BindingResponse> {
    let record = BINDINGS.load(deps.storage, &agent_id)?;
    let valid_now = env.block.time.seconds() <= record.expires_at;
    Ok(BindingResponse {
        agent_id,
        record,
        valid_now,
    })
}

fn query_agent_by_address(deps: Deps, address: String) -> StdResult<AgentByAddressResponse> {
    let addr = deps.api.addr_validate(&address)?;
    let agent_id = ADDRESS_TO_AGENT.may_load(deps.storage, &addr)?;
    Ok(AgentByAddressResponse { agent_id })
}

fn query_agents(
    deps: Deps,
    start_after: Option<String>,
    limit: Option<u32>,
) -> StdResult<AgentsResponse> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let start = start_after.as_deref().map(Bound::exclusive);
    let agents = AGENTS
        .range(deps.storage, start, None, Order::Ascending)
        .take(limit)
        .map(|item| {
            let (agent_id, record) = item?;
            Ok(AgentResponse { agent_id, record })
        })
        .collect::<StdResult<Vec<_>>>()?;
    Ok(AgentsResponse { agents })
}

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::testing::{
        message_info, mock_dependencies, mock_env, MockApi,
    };
    use cosmwasm_std::from_json;

    fn caid(api: &MockApi) -> (String, String) {
        let _ = api;
        (
            "cred402:casper:weather-risk-agent-01".to_string(),
            "01aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899".to_string(),
        )
    }

    #[test]
    fn instantiate_and_register() {
        let mut deps = mock_dependencies();
        let env = mock_env();
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

        let (caid_str, casper_account) = caid(&deps.api);
        execute(
            deps.as_mut(),
            env.clone(),
            info.clone(),
            ExecuteMsg::RegisterAgent {
                caid: caid_str,
                casper_account,
            },
        )
        .unwrap();

        let res = query(
            deps.as_ref(),
            env,
            QueryMsg::Agent {
                agent_id: "weather-risk-agent-01".to_string(),
            },
        )
        .unwrap();
        let parsed: AgentResponse = from_json(res).unwrap();
        assert!(parsed.record.active);
        assert_eq!(parsed.agent_id, "weather-risk-agent-01");
    }

    #[test]
    fn rejects_non_casper_caid() {
        let mut deps = mock_dependencies();
        let env = mock_env();
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

        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::RegisterAgent {
                caid: "cred402:eip155:8453:agent".to_string(),
                casper_account: "01ff".to_string(),
            },
        )
        .unwrap_err();
        matches!(err, ContractError::InvalidCaid { .. });
    }

    #[test]
    fn binding_reverse_lookup() {
        let mut deps = mock_dependencies();
        let env = mock_env();
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
        let (caid_str, casper_account) = caid(&deps.api);
        execute(
            deps.as_mut(),
            env.clone(),
            info.clone(),
            ExecuteMsg::RegisterAgent {
                caid: caid_str,
                casper_account,
            },
        )
        .unwrap();

        let bound = deps.api.addr_make("agentwallet");
        execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::UpsertBinding {
                agent_id: "weather-risk-agent-01".to_string(),
                cosmos_address: bound.to_string(),
                external_chain: "cosmos:cred402-rwa-1".to_string(),
                nonce: "n1".to_string(),
                expires_at: env.block.time.seconds() + 3600,
            },
        )
        .unwrap();

        let res = query(
            deps.as_ref(),
            env,
            QueryMsg::AgentByAddress {
                address: bound.to_string(),
            },
        )
        .unwrap();
        let parsed: AgentByAddressResponse = from_json(res).unwrap();
        assert_eq!(parsed.agent_id.as_deref(), Some("weather-risk-agent-01"));
    }
}
