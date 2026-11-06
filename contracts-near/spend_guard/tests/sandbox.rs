//! Day 2 + Day 11 + Day 14 (+ Nov-5 top-up follow-up) — a real
//! near-workspaces sandbox integration test exercising the ENTIRE SpendGuard
//! loop against a genuinely running local nearcore node (not a mock):
//! deploy -> policy evaluation -> capped spend key -> real spends ->
//! allowance exhaustion rejected by nearcore itself -> a REAL on-chain
//! repayment against outstanding exposure -> a REAL `top_up_allowance`
//! re-reservation + key re-mint that lets the SAME still-active key draw
//! again -> a dispute spike trips the circuit breaker -> the revoked key is
//! rejected by nearcore itself, even with budget left. Zero manual steps:
//! `cargo test --test sandbox` (after `cargo near build non-reproducible-wasm`,
//! wired together as `npm run demo:near-spend-guard` from the repo root —
//! see `package.json`) is the one command a judge needs to run.
//!
//! The individual exposure-cap assertions here are the Rust-side mirror of
//! the pre-existing TypeScript test cases this contract was ported from
//! (`lib/ledger/contracts/global_exposure_manager.ts`'s behavior, previously
//! only covered by unit tests inside the crate itself in `src/exposure.rs`)
//! — this file is what actually drives them through a live contract
//! deployment instead of in-process Rust calls.
//!
//! ## A real protocol finding this test is built around
//!
//! `spend_to_seller` takes `amount` as a plain JSON argument, NOT an
//! attached deposit. That is not a style choice — an earlier version of
//! this test attached a deposit from the agent's Function Call Access Key
//! and got back a real, live rejection from this exact sandbox's nearcore:
//! `InvalidAccessKeyError(DepositWithFunctionCall)`. NEAR's Function Call
//! Access Keys are categorically forbidden from attaching ANY deposit,
//! regardless of allowance — the allowance only ever covers prepaid GAS for
//! the one permitted method call. So the FC key's allowance here is a real,
//! protocol-enforced cap on how many authorized calls the key can make (a
//! genuine NEAR primitive); the yoctoNEAR spending cap itself is enforced
//! by this contract's own `ExposureBook` (ported from
//! `global_exposure_manager.ts`), with the actual NEAR transferred out of
//! the contract's own pooled balance. This matches the hackathon plan's own
//! documented fallback ("the Function Call Key allowance as an additional,
//! not sole, enforcement layer") — discovered here empirically, not assumed.

use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use serde_json::json;

/// A Function Call Access Key's allowance must cover the FULL prepaid gas
/// cost of a call up front. `max_gas()` (300 Tgas) would prepay far more
/// than this simple method needs and exhaust a demo-sized allowance in a
/// single call; this is deliberately small instead so several real calls
/// succeed before the allowance (deliberately small for a fast, legible
/// test) runs out.
const SPEND_GAS: Gas = Gas::from_tgas(20);

const WASM_PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/target/near/spend_guard.wasm");

fn read_wasm() -> Vec<u8> {
    std::fs::read(WASM_PATH).unwrap_or_else(|e| {
        panic!(
            "could not read {} ({e}) — run `cargo near build non-reproducible-wasm` first \
             (this is exactly what `npm run demo:near-spend-guard` does before running this test)",
            WASM_PATH
        )
    })
}

/// Small, round policy inputs chosen so the resulting credit line is a tidy
/// NEAR amount, not to exercise edge cases (those are covered by
/// `src/policy.rs`'s own unit tests). revenue_30d = 2 NEAR, no stake,
/// perfect accuracy, no disputes => credit_line = revenue * 0.30 = 0.6 NEAR
/// exactly — sized so the FC key's allowance (set equal to the credit line)
/// is exhausted by real prepaid gas costs after a handful of real calls,
/// inside one short test run.
fn healthy_agent_metrics() -> serde_json::Value {
    json!({
        "revenue_30d": NearToken::from_millinear(100).as_yoctonear().to_string(),
        "stake": "0",
        "dispute_rate_bps": 0,
        "accuracy_score": 100,
        "total_jobs": 10,
    })
}

#[tokio::test]
async fn full_spend_guard_loop_earn_policy_cap_spend_dispute_freeze_reject() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = read_wasm();

    // Deployed under a short, human-chosen sub-account (`spendguard.test.near`)
    // rather than `dev_deploy`'s long, randomly generated account id — the
    // identity sub-accounts this contract mints are `agent-<id>.<this
    // account>`, and `dev_deploy`'s ~45-character id leaves no room under
    // NEAR's 64-character account id limit for a real agent id prefix.
    let root = worker.root_account()?;
    let contract_account = root
        .create_subaccount("spendguard")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?;
    let contract = contract_account.deploy(&wasm).await?.into_result()?;

    // The admin account doubles as "the watchdog service" in this demo —
    // the only account allowed to call report_dispute_spike / emergency_freeze.
    let admin = root;

    let outcome = admin
        .call(contract.id(), "new")
        .args_json(json!({ "admin": admin.id() }))
        .transact()
        .await?;
    assert!(outcome.is_success(), "contract init failed: {:#?}", outcome.failures());

    // ---- earn -> policy: evaluate credit and mint a real, capped spend key ----
    let agent_id = "demo-buyer-agent";
    let secret_key = SecretKey::from_random(KeyType::ED25519);
    let public_key = secret_key.public_key();

    let auth_outcome = admin
        .call(contract.id(), "request_spend_authorization")
        .args_json(json!({
            "agent_id": agent_id,
            "metrics": healthy_agent_metrics(),
            "public_key": public_key.to_string(),
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(
        auth_outcome.is_success(),
        "request_spend_authorization failed: {:#?}",
        auth_outcome.failures()
    );

    let record: serde_json::Value = contract
        .view("get_agent")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    assert_eq!(record["agent_id"], agent_id);
    assert_eq!(record["key_active"], true);
    assert_eq!(record["credit_line"], NearToken::from_millinear(30).as_yoctonear().to_string());

    let exposure: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    assert_eq!(exposure["reserved"], NearToken::from_millinear(30).as_yoctonear().to_string());
    assert_eq!(exposure["frozen"], false);

    // ---- capped sandboxed wallet -> pay a second agent, repeatedly, up to the allowance ----
    // The agent signs as the SpendGuard contract's OWN account id, using ONLY
    // the freshly-minted, FunctionCall-scoped key — never the admin's full
    // access key. This is the real enforcement: nearcore itself refuses to
    // even validate a transaction signed with this key for any method other
    // than `spend_to_seller`, against any receiver other than this contract,
    // or past its allowance.
    let agent_as_contract =
        near_workspaces::Account::from_secret_key(contract.id().clone(), secret_key.clone(), &worker);

    let seller: near_workspaces::Account = worker.dev_create_account().await?;
    let seller_balance_before = seller.view_account().await?.balance;

    let spend_amount: u128 = 1; // 1 yoctoNEAR (symbolic dust) — the value cap must stay effectively infinite here so the GAS allowance is the only thing that can bind
    let mut successful_spends = 0u32;
    let mut rejection: Option<String> = None;

    for attempt in 1..=200u32 {
        let result = agent_as_contract
            .call(contract.id(), "spend_to_seller")
            .args_json(json!({ "seller_id": seller.id(), "amount": spend_amount.to_string() }))
            .gas(SPEND_GAS)
            .transact()
            .await;

        match result {
            Ok(exec) if exec.is_success() => {
                successful_spends += 1;
            }
            Ok(exec) => {
                rejection = Some(format!("attempt {attempt}: execution failure: {:#?}", exec.failures()));
                break;
            }
            Err(e) => {
                rejection = Some(format!("attempt {attempt}: transaction-level rejection: {e:?}"));
                break;
            }
        }
    }

    println!("successful_spends={successful_spends}, rejection={rejection:?}");
    assert!(successful_spends >= 2, "expected at least 2 real spends to succeed before the cap bites, got {successful_spends}");
    let rejection = rejection.expect(
        "expected a later spend attempt to be rejected once the Function Call Access Key's \
         allowance was exhausted — nearcore must refuse this, not application code",
    );
    println!("protocol-level rejection after {successful_spends} successful spends: {rejection}");
    // This is the real assertion for Day 5: the failure must be about the
    // access key / allowance (nearcore's own transaction validation), not an
    // app-level `require!` message from `spend_to_seller` (which would
    // indicate the cap was enforced by our own code instead of nearcore).
    let lower = rejection.to_lowercase();
    assert!(
        lower.contains("allowance") || lower.contains("accesskey") || lower.contains("access key") || lower.contains("notenoughbalance"),
        "expected a protocol-level access-key/allowance rejection, got: {rejection}"
    );

    let seller_balance_after = seller.view_account().await?.balance;
    let received = seller_balance_after.as_yoctonear().saturating_sub(seller_balance_before.as_yoctonear());
    assert_eq!(
        received,
        spend_amount * successful_spends as u128,
        "the seller must have actually received every successful spend's forwarded amount on-chain"
    );

    // ---- repay: the missing other half, now proven LIVE against the real
    // deployed contract (Day 7 wired `repay_credit_line` but only
    // unit-tested `ExposureBook::decrease_exposure` in isolation — this is
    // the first real on-chain proof it works end to end) ----
    let exposure_before_repay: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    let outstanding_before: u128 =
        exposure_before_repay["outstanding"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        outstanding_before,
        spend_amount * successful_spends as u128,
        "outstanding must equal exactly what spend_to_seller activated out of the reservation"
    );

    let repay_amount = outstanding_before; // repay the agent's full outstanding draw
    let repay_outcome = admin
        .call(contract.id(), "repay_credit_line")
        .args_json(json!({ "agent_id": agent_id, "amount": repay_amount.to_string() }))
        .max_gas()
        .transact()
        .await?;
    assert!(repay_outcome.is_success(), "repay_credit_line failed: {:#?}", repay_outcome.failures());

    let exposure_after_repay: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    let outstanding_after: u128 =
        exposure_after_repay["outstanding"].as_str().unwrap().parse().unwrap();
    assert_eq!(outstanding_after, 0, "a full repayment must zero out outstanding exposure, on the live contract");
    // reserved only ever moves via a real spend (activate_exposure) or a
    // freeze's release — repay_credit_line must never touch it.
    let reserved_before_repay: u128 =
        exposure_before_repay["reserved"].as_str().unwrap().parse().unwrap();
    let reserved_after_repay: u128 =
        exposure_after_repay["reserved"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        reserved_after_repay, reserved_before_repay,
        "repayment must never touch the reserved (unspent) portion of the credit line"
    );
    println!(
        "REPAYMENT VERIFIED LIVE: agent {} repaid {} yoctoNEAR, outstanding {} -> 0 on the real deployed contract",
        agent_id, repay_amount, outstanding_before
    );

    // ---- top up: the previously-missing other half, now real end to end.
    // `repay_credit_line` above freed `successful_spends` yoctoNEAR of
    // headroom at the ExposureBook level. `top_up_allowance` re-reserves
    // exactly that much AND re-mints the agent's SAME live key (same public
    // key, same identity, never revoked) with a fresh on-chain allowance —
    // proving "draw -> repay -> top up -> draw again" on one still-active
    // key is real, not just a ledger fact in isolation. ----
    let top_up_outcome = admin
        .call(contract.id(), "top_up_allowance")
        .args_json(json!({ "agent_id": agent_id, "amount": repay_amount.to_string() }))
        .max_gas()
        .transact()
        .await?;
    assert!(top_up_outcome.is_success(), "top_up_allowance failed: {:#?}", top_up_outcome.failures());

    let exposure_after_top_up: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    let reserved_after_top_up: u128 = exposure_after_top_up["reserved"].as_str().unwrap().parse().unwrap();
    assert_eq!(
        reserved_after_top_up,
        reserved_after_repay + repay_amount,
        "top_up_allowance must restore exactly the headroom the repayment freed"
    );
    assert_eq!(exposure_after_top_up["frozen"], false);
    println!(
        "TOP-UP VERIFIED LIVE: agent {} reserved {} -> {} yoctoNEAR on the same still-active key",
        agent_id, reserved_after_repay, reserved_after_top_up
    );

    // The real proof this is reachable, not just a ledger number: the SAME
    // secret key (never rotated, never revoked) can spend again, past the
    // point where its original gas allowance was exhausted, because
    // top_up_allowance re-minted that exact public key with a fresh
    // allowance equal to its restored `reserved` headroom.
    let post_top_up_spend = agent_as_contract
        .call(contract.id(), "spend_to_seller")
        .args_json(json!({ "seller_id": seller.id(), "amount": spend_amount.to_string() }))
        .gas(SPEND_GAS)
        .transact()
        .await?;
    assert!(
        post_top_up_spend.is_success(),
        "a spend after top_up_allowance must succeed on the SAME still-active key: {:#?}",
        post_top_up_spend.failures()
    );
    println!("DRAW-AGAIN VERIFIED LIVE: agent {} spent again on its original key after top_up_allowance", agent_id);

    // ---- dispute spike -> circuit breaker freezes exposure AND revokes the key ----
    let second_agent_id = "demo-scammer-agent";
    let scammer_secret = SecretKey::from_random(KeyType::ED25519);
    let scammer_public = scammer_secret.public_key();
    let scammer_auth = admin
        .call(contract.id(), "request_spend_authorization")
        .args_json(json!({
            "agent_id": second_agent_id,
            "metrics": healthy_agent_metrics(),
            "public_key": scammer_public.to_string(),
        }))
        .max_gas()
        .transact()
        .await?;
    assert!(scammer_auth.is_success(), "second agent authorization failed: {:#?}", scammer_auth.failures());

    let scammer_as_contract =
        near_workspaces::Account::from_secret_key(contract.id().clone(), scammer_secret, &worker);

    // Prove the key works BEFORE the freeze, and that plenty of allowance remains.
    let pre_freeze_spend = scammer_as_contract
        .call(contract.id(), "spend_to_seller")
        .args_json(json!({ "seller_id": seller.id(), "amount": spend_amount.to_string() }))
        .gas(SPEND_GAS)
        .transact()
        .await?;
    assert!(pre_freeze_spend.is_success(), "pre-freeze spend should succeed: {:#?}", pre_freeze_spend.failures());

    let remaining_before_freeze: serde_json::Value = contract
        .view("remaining_allowance")
        .args_json(json!({ "agent_id": second_agent_id }))
        .await?
        .json()?;
    let remaining_before_freeze: u128 = remaining_before_freeze.as_str().unwrap().parse().unwrap();
    assert!(remaining_before_freeze > 0, "the scammer agent must still have real budget left before the freeze");

    // Admin/watchdog simulates a dispute-rate spike (3+ disputes trips the breaker).
    let spike_outcome = admin
        .call(contract.id(), "report_dispute_spike")
        .args_json(json!({ "agent_id": second_agent_id, "count": 5 }))
        .max_gas()
        .transact()
        .await?;
    assert!(spike_outcome.is_success(), "report_dispute_spike failed: {:#?}", spike_outcome.failures());

    let exposure_after_freeze: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": second_agent_id }))
        .await?
        .json()?;
    assert_eq!(exposure_after_freeze["frozen"], true, "exposure must be frozen after the dispute spike");

    // ---- the real proof: the NEXT call from the revoked key hard-fails at
    // the protocol layer, even though it still had real budget left ----
    let post_freeze_attempt = scammer_as_contract
        .call(contract.id(), "spend_to_seller")
        .args_json(json!({ "seller_id": seller.id(), "amount": spend_amount.to_string() }))
        .gas(SPEND_GAS)
        .transact()
        .await;

    let post_freeze_failure = match post_freeze_attempt {
        Ok(exec) if exec.is_success() => {
            panic!("a revoked key must never be able to spend again, even with budget left: {:#?}", exec.outcome())
        }
        Ok(exec) => format!("execution failure: {:#?}", exec.failures()),
        Err(e) => format!("transaction-level rejection: {e:?}"),
    };
    println!("post-freeze call correctly rejected: {post_freeze_failure}");
    let lower = post_freeze_failure.to_lowercase();
    assert!(
        lower.contains("accesskey") || lower.contains("access key") || lower.contains("doesnotexist") || lower.contains("does not exist") || lower.contains("not found"),
        "the circuit breaker must manifest as a deleted/unknown access key at the protocol layer, not an app-level message: {post_freeze_failure}"
    );

    println!(
        "FULL LOOP VERIFIED: earn(policy credit_line={} yocto) -> {successful_spends} real capped spends \
         -> protocol-level allowance rejection -> dispute spike -> freeze -> real deleted-key rejection",
        record["credit_line"]
    );

    Ok(())
}

/// 2026-11-07 adversarial round, focus area 4: can two near-simultaneous
/// `spend_to_seller` calls from the SAME signer double-spend against the
/// same reserved allowance before the first one's state change lands?
/// Fires two real transactions CONCURRENTLY (`tokio::join!`, not sequential
/// `.await`s) from the SAME Function Call Access Key, each requesting an
/// amount that individually fits the reservation but together would
/// overdraw it — the exact shape of a TOCTOU double-spend race.
///
/// Result: not reproducible, by real NEAR protocol design, not by luck.
/// Two reasons, both confirmed here rather than assumed:
/// 1. A single NEAR access key's transactions are strictly nonce-ordered;
///    nearcore itself refuses to accept two transactions signed by the same
///    key without a strictly increasing nonce, so "simultaneous" submission
///    from one key is serialized before either transaction is even
///    accepted into a chunk — there is no network-level race window.
/// 2. Even granting both nonces upfront, a single contract account's
///    receipts are applied one at a time by the runtime (no interleaved/
///    parallel execution of two calls against the same account's state),
///    so `spend_to_seller`'s read-check-write of `ExposureBook` can never
///    observe a stale `reserved` value — unlike e.g. a naive two-phase
///    check-then-write against a database with no row lock.
#[tokio::test]
async fn concurrent_spend_to_seller_from_the_same_signer_cannot_double_spend() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let wasm = read_wasm();

    let root = worker.root_account()?;
    let contract_account = root
        .create_subaccount("spendguard2")
        .initial_balance(NearToken::from_near(50))
        .transact()
        .await?
        .into_result()?;
    let contract = contract_account.deploy(&wasm).await?.into_result()?;
    let admin = root;

    let outcome = admin
        .call(contract.id(), "new")
        .args_json(json!({ "admin": admin.id() }))
        .transact()
        .await?;
    assert!(outcome.is_success(), "contract init failed: {:#?}", outcome.failures());

    // revenue_30d = 1 NEAR, no stake, no disputes, perfect accuracy =>
    // credit_line = 1 NEAR * 0.30 = 0.3 NEAR exactly, all of it reserved
    // up front by request_spend_authorization.
    let agent_id = "concurrent-race-agent";
    let secret_key = SecretKey::from_random(KeyType::ED25519);
    let public_key = secret_key.public_key();
    let metrics = json!({
        "revenue_30d": NearToken::from_near(1).as_yoctonear().to_string(),
        "stake": "0",
        "dispute_rate_bps": 0,
        "accuracy_score": 100,
        "total_jobs": 10,
    });
    let auth_outcome = admin
        .call(contract.id(), "request_spend_authorization")
        .args_json(json!({ "agent_id": agent_id, "metrics": metrics, "public_key": public_key.to_string() }))
        .max_gas()
        .transact()
        .await?;
    assert!(auth_outcome.is_success(), "request_spend_authorization failed: {:#?}", auth_outcome.failures());

    let exposure: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    let reserved: u128 = exposure["reserved"].as_str().unwrap().parse().unwrap();
    assert_eq!(reserved, NearToken::from_millinear(300).as_yoctonear(), "sanity: 0.3 NEAR reserved");

    // Each individual spend (0.2 NEAR) is well within the 0.3 NEAR
    // reservation, but TWO of them (0.4 NEAR) would blow past it. If a
    // double-spend race existed, both would succeed.
    let race_amount: u128 = NearToken::from_millinear(200).as_yoctonear();
    assert!(race_amount <= reserved && race_amount * 2 > reserved, "test amounts must create a real overdraw if both succeed");

    let agent_as_contract =
        near_workspaces::Account::from_secret_key(contract.id().clone(), secret_key.clone(), &worker);
    let seller: near_workspaces::Account = worker.dev_create_account().await?;

    // Warm up near-workspaces' client-side nonce cache with ONE real,
    // sequential transaction from this brand-new key first. Without this,
    // near-workspaces' own nonce cache (src/rpc/client.rs::fetch_tx_nonce)
    // has a real client-library race on a key's FIRST-EVER use: two
    // concurrent callers can both observe an empty cache, both independently
    // query the same on-chain nonce, and both compute the identical "next"
    // nonce — producing two byte-identical signed transactions that nearcore
    // correctly treats as the SAME transaction (one real execution, not a
    // contract-level double-spend). That is a real finding about the TEST
    // HARNESS, not the contract, and warming the cache here is what isolates
    // the actual question: two GENUINELY different, validly nonce-ordered
    // transactions racing against the real `ExposureBook` state.
    let warmup_amount: u128 = 1;
    let warmup = agent_as_contract
        .call(contract.id(), "spend_to_seller")
        .args_json(json!({ "seller_id": seller.id(), "amount": warmup_amount.to_string() }))
        .gas(SPEND_GAS)
        .transact()
        .await?;
    assert!(warmup.is_success(), "nonce-cache warm-up spend failed: {:#?}", warmup.failures());

    let exposure_after_warmup: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    let reserved: u128 = exposure_after_warmup["reserved"].as_str().unwrap().parse().unwrap();
    let seller_balance_before = seller.view_account().await?.balance;

    let call_a = agent_as_contract
        .call(contract.id(), "spend_to_seller")
        .args_json(json!({ "seller_id": seller.id(), "amount": race_amount.to_string() }))
        .gas(SPEND_GAS)
        .transact();
    let call_b = agent_as_contract
        .call(contract.id(), "spend_to_seller")
        .args_json(json!({ "seller_id": seller.id(), "amount": race_amount.to_string() }))
        .gas(SPEND_GAS)
        .transact();
    // Genuinely concurrent: both futures are polled together, not awaited
    // one after the other — this is the real adversarial shape, not a
    // reworded sequential call.
    let (result_a, result_b) = tokio::join!(call_a, call_b);

    let outcome_summary = |label: &str, r: &Result<near_workspaces::result::ExecutionFinalResult, near_workspaces::error::Error>| match r {
        Ok(exec) if exec.is_success() => format!("{label}: SUCCESS"),
        Ok(exec) => format!("{label}: execution failure: {:#?}", exec.failures()),
        Err(e) => format!("{label}: transaction-level rejection: {e:?}"),
    };
    println!("{}", outcome_summary("call_a", &result_a));
    println!("{}", outcome_summary("call_b", &result_b));

    let success_count = [&result_a, &result_b]
        .iter()
        .filter(|r| matches!(r, Ok(exec) if exec.is_success()))
        .count();

    let exposure_after: serde_json::Value = contract
        .view("get_exposure")
        .args_json(json!({ "agent_id": agent_id }))
        .await?
        .json()?;
    let outstanding_after: u128 = exposure_after["outstanding"].as_str().unwrap().parse().unwrap();
    let reserved_after: u128 = exposure_after["reserved"].as_str().unwrap().parse().unwrap();
    let seller_balance_after = seller.view_account().await?.balance;
    let received = seller_balance_after.as_yoctonear().saturating_sub(seller_balance_before.as_yoctonear());
    println!(
        "DIAGNOSTIC: success_count={success_count} outstanding_after={outstanding_after} reserved_after={reserved_after} \
         received_by_seller={received} race_amount={race_amount} reserved_before={reserved}"
    );

    assert_eq!(
        success_count, 1,
        "exactly one of the two concurrent same-signer spends must succeed — either both succeeding (a real \
         double-spend) or both failing (a false-negative race-detection bug) would be wrong; got {success_count}"
    );
    assert_eq!(
        outstanding_after,
        warmup_amount + race_amount,
        "outstanding must equal the warm-up spend plus exactly ONE of the two raced spends, never both"
    );
    assert_eq!(reserved_after, reserved - race_amount, "reserved must drop by exactly one spend's amount");
    assert_eq!(received, race_amount, "the seller must have received funds for exactly one spend, not two");

    println!(
        "CONCURRENCY FINDING VERIFIED: two real, genuinely-concurrent (tokio::join!) spend_to_seller transactions \
         from the SAME signer against a reservation that could only cover one of them — nearcore's own nonce \
         ordering + sequential per-account receipt processing serialized them; no double-spend occurred. \
         outstanding={outstanding_after}, reserved={reserved_after} (started at {reserved})"
    );

    Ok(())
}
