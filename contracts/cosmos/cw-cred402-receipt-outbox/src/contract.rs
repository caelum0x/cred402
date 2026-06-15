#[cfg(not(feature = "library"))]
use cosmwasm_std::entry_point;
use cosmwasm_std::{
    to_json_binary, Binary, Deps, DepsMut, Env, MessageInfo, Order, Response, StdResult,
};
use cw_storage_plus::Bound;

use crate::canonical::hash_canonical;
use crate::error::ContractError;
use crate::msg::{
    ComputeIdResponse, ExecuteMsg, InstantiateMsg, OutboxResponse, QueryMsg, ReceiptResponse,
};
use crate::state::{
    Config, StoredReceipt, UniversalReceiptEnvelope, CONFIG, OUTBOX, RECEIPTS, RECEIPT_TYPE,
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
    let admin = match msg.admin {
        Some(a) => deps.api.addr_validate(&a)?,
        None => info.sender.clone(),
    };
    let config = Config {
        admin,
        origin_chain: msg.origin_chain,
        settlement_network: msg.settlement_network,
        sequence: 0,
    };
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "instantiate")
        .add_attribute("contract", "cw-cred402-receipt-outbox")
        .add_attribute("origin_chain", config.origin_chain)
        .add_attribute("admin", config.admin.to_string()))
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn execute(
    deps: DepsMut,
    env: Env,
    info: MessageInfo,
    msg: ExecuteMsg,
) -> Result<Response, ContractError> {
    match msg {
        ExecuteMsg::SettleReceipt {
            envelope,
            claimed_receipt_id,
        } => execute_settle(deps, env, info, envelope, claimed_receipt_id),
        ExecuteMsg::MarkAnchored { receipt_id } => execute_mark_anchored(deps, info, receipt_id),
        ExecuteMsg::UpdateAdmin { new_admin } => execute_update_admin(deps, info, new_admin),
    }
}

/// Validate the envelope structurally, recompute the canonical receipt id,
/// enforce the optional claimed id, store it, and append to the outbox.
fn execute_settle(
    deps: DepsMut,
    _env: Env,
    _info: MessageInfo,
    envelope: UniversalReceiptEnvelope,
    claimed_receipt_id: Option<String>,
) -> Result<Response, ContractError> {
    // Structural validation mirrors `verifyUniversalReceipt`.
    require_nonempty("origin_chain", &envelope.origin_chain)?;
    require_nonempty("payer_agent_id", &envelope.payer_agent_id)?;
    require_nonempty("seller_agent_id", &envelope.seller_agent_id)?;
    require_nonempty("amount", &envelope.amount)?;
    require_nonempty("service_type", &envelope.service_type)?;
    require_nonempty("payment_proof_hash", &envelope.payment_proof_hash)?;
    require_nonempty("nonce", &envelope.nonce)?;
    if !is_integer_string(&envelope.amount) {
        return Err(ContractError::InvalidAmount {
            amount: envelope.amount.clone(),
        });
    }

    let receipt_id = hash_canonical(&envelope.to_canonical());
    if let Some(claimed) = claimed_receipt_id {
        if claimed != receipt_id {
            return Err(ContractError::ReceiptIdMismatch {
                claimed,
                computed: receipt_id,
            });
        }
    }
    if RECEIPTS.has(deps.storage, &receipt_id) {
        return Err(ContractError::DuplicateReceipt { receipt_id });
    }

    let mut config = CONFIG.load(deps.storage)?;
    let sequence = config.sequence + 1;
    config = Config {
        sequence,
        ..config
    };
    CONFIG.save(deps.storage, &config)?;

    let stored = StoredReceipt {
        envelope,
        receipt_id: receipt_id.clone(),
        sequence,
        anchored: false,
    };
    RECEIPTS.save(deps.storage, &receipt_id, &stored)?;
    OUTBOX.save(deps.storage, sequence, &receipt_id)?;

    Ok(Response::new()
        // Event the cosmos->casper relayer subscribes to for anchoring.
        .add_attribute("action", "settle_receipt")
        .add_attribute("receipt_id", receipt_id)
        .add_attribute("sequence", sequence.to_string())
        .add_attribute("payer_agent_id", stored.envelope.payer_agent_id)
        .add_attribute("seller_agent_id", stored.envelope.seller_agent_id)
        .add_attribute("asset", stored.envelope.asset)
        .add_attribute("amount", stored.envelope.amount))
}

fn execute_mark_anchored(
    deps: DepsMut,
    info: MessageInfo,
    receipt_id: String,
) -> Result<Response, ContractError> {
    let config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    let mut stored =
        RECEIPTS
            .may_load(deps.storage, &receipt_id)?
            .ok_or(ContractError::MissingField {
                field: "receipt_id".to_string(),
            })?;
    stored = StoredReceipt {
        anchored: true,
        ..stored
    };
    RECEIPTS.save(deps.storage, &receipt_id, &stored)?;
    OUTBOX.remove(deps.storage, stored.sequence);

    Ok(Response::new()
        .add_attribute("action", "mark_anchored")
        .add_attribute("receipt_id", receipt_id))
}

fn execute_update_admin(
    deps: DepsMut,
    info: MessageInfo,
    new_admin: String,
) -> Result<Response, ContractError> {
    let mut config = CONFIG.load(deps.storage)?;
    if info.sender != config.admin {
        return Err(ContractError::Unauthorized {});
    }
    let new_admin = deps.api.addr_validate(&new_admin)?;
    config = Config {
        admin: new_admin.clone(),
        ..config
    };
    CONFIG.save(deps.storage, &config)?;
    Ok(Response::new()
        .add_attribute("action", "update_admin")
        .add_attribute("new_admin", new_admin.to_string()))
}

fn require_nonempty(field: &str, value: &str) -> Result<(), ContractError> {
    if value.is_empty() {
        return Err(ContractError::MissingField {
            field: field.to_string(),
        });
    }
    Ok(())
}

/// True iff `s` is a non-empty base-10 integer string (matches `/^\d+$/`).
fn is_integer_string(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

#[cfg_attr(not(feature = "library"), entry_point)]
pub fn query(deps: Deps, _env: Env, msg: QueryMsg) -> StdResult<Binary> {
    match msg {
        QueryMsg::Config {} => to_json_binary(&CONFIG.load(deps.storage)?),
        QueryMsg::Receipt { receipt_id } => {
            let receipt = RECEIPTS.load(deps.storage, &receipt_id)?;
            to_json_binary(&ReceiptResponse { receipt })
        }
        QueryMsg::PendingOutbox { start_after, limit } => {
            to_json_binary(&query_pending(deps, start_after, limit)?)
        }
        QueryMsg::ComputeReceiptId { envelope } => {
            let mut e = envelope;
            // Ensure the type discriminant is the canonical constant.
            let receipt_id = hash_canonical(&e.to_canonical());
            // Avoid unused-mut warning on builds without further use.
            let _ = &mut e;
            to_json_binary(&ComputeIdResponse { receipt_id })
        }
    }
}

fn query_pending(
    deps: Deps,
    start_after: Option<u64>,
    limit: Option<u32>,
) -> StdResult<OutboxResponse> {
    let limit = limit.unwrap_or(DEFAULT_LIMIT).min(MAX_LIMIT) as usize;
    let start = start_after.map(Bound::exclusive);
    let mut entries = Vec::new();
    for item in OUTBOX
        .range(deps.storage, start, None, Order::Ascending)
        .take(limit)
    {
        let (_seq, receipt_id) = item?;
        let stored = RECEIPTS.load(deps.storage, &receipt_id)?;
        entries.push(stored);
    }
    Ok(OutboxResponse { entries })
}

const _: &str = RECEIPT_TYPE;

#[cfg(test)]
mod tests {
    use super::*;
    use cosmwasm_std::from_json;
    use cosmwasm_std::testing::{message_info, mock_dependencies, mock_env};

    fn sample(env: &Env) -> UniversalReceiptEnvelope {
        UniversalReceiptEnvelope {
            origin_chain: "cosmos:cred402-rwa-1".to_string(),
            settlement_network: "cred402-rwa-1".to_string(),
            payer_agent_id: "payer-agent".to_string(),
            seller_agent_id: "seller-agent".to_string(),
            payer_address: "cosmos1payer".to_string(),
            seller_address: "cosmos1seller".to_string(),
            asset: "USDC".to_string(),
            amount: "1500000".to_string(),
            service_type: "rwa-valuation".to_string(),
            request_hash: "0xreq".to_string(),
            result_hash: "0xres".to_string(),
            payment_proof_hash: "0xproof".to_string(),
            settlement_tx_hash: "0xtx".to_string(),
            nonce: "nonce-1".to_string(),
            created_at: env.block.time.seconds(),
        }
    }

    #[test]
    fn settle_computes_and_stores_receipt() {
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
                origin_chain: "cosmos:cred402-rwa-1".to_string(),
                settlement_network: "cred402-rwa-1".to_string(),
            },
        )
        .unwrap();

        let env_msg = sample(&env);
        let res = execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::SettleReceipt {
                envelope: env_msg.clone(),
                claimed_receipt_id: None,
            },
        )
        .unwrap();
        let rid = res
            .attributes
            .iter()
            .find(|a| a.key == "receipt_id")
            .unwrap()
            .value
            .clone();
        assert!(rid.starts_with("0x"));
        assert_eq!(rid.len(), 66);

        let q = query(
            deps.as_ref(),
            env,
            QueryMsg::Receipt {
                receipt_id: rid.clone(),
            },
        )
        .unwrap();
        let parsed: ReceiptResponse = from_json(q).unwrap();
        assert_eq!(parsed.receipt.receipt_id, rid);
        assert!(!parsed.receipt.anchored);
    }

    #[test]
    fn rejects_wrong_claimed_id() {
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
                origin_chain: "cosmos:cred402-rwa-1".to_string(),
                settlement_network: "cred402-rwa-1".to_string(),
            },
        )
        .unwrap();
        let err = execute(
            deps.as_mut(),
            env.clone(),
            info,
            ExecuteMsg::SettleReceipt {
                envelope: sample(&env),
                claimed_receipt_id: Some("0xdeadbeef".to_string()),
            },
        )
        .unwrap_err();
        matches!(err, ContractError::ReceiptIdMismatch { .. });
    }

    #[test]
    fn rejects_non_integer_amount() {
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
                origin_chain: "cosmos:cred402-rwa-1".to_string(),
                settlement_network: "cred402-rwa-1".to_string(),
            },
        )
        .unwrap();
        let mut bad = sample(&env);
        bad.amount = "12.5".to_string();
        let err = execute(
            deps.as_mut(),
            env,
            info,
            ExecuteMsg::SettleReceipt {
                envelope: bad,
                claimed_receipt_id: None,
            },
        )
        .unwrap_err();
        matches!(err, ContractError::InvalidAmount { .. });
    }
}
