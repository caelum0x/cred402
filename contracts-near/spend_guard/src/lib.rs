//! SpendGuard — NEAR Hackathon 2026 (Agent Economy / AI Security & Defense).
//!
//! Turns an AI agent's verified on-chain x402 revenue into a capped,
//! protocol-enforced spending permission: `policy.rs` underwrites a credit
//! line from the agent's metrics (ported from cred402's Casper
//! `RiskPolicyManager`), `exposure.rs` reserves that line against a global
//! multichain exposure cap (ported from cred402's TypeScript
//! `GlobalExposureManager`), and `spend_key.rs` turns the approved line into
//! a real NEAR Function Call Access Key whose `allowance` nearcore itself
//! enforces. `scam_detection.rs` is the circuit breaker: a dispute-rate
//! spike freezes the agent and revokes that key outright, independent of
//! whether its budget was exhausted.
//!
//! See `spend_key.rs` for why the live spending key is minted on this
//! contract's own account (receiver_id = self) rather than directly on the
//! agent's identity sub-account — a deliberate, documented consequence of
//! NEAR's AddKey/DeleteKey permission model, not an oversight.

mod exposure;
mod policy;
mod scam_detection;
mod spend_key;

use near_sdk::borsh::BorshSerialize;
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise, PublicKey};

pub use exposure::AgentExposure;
pub use policy::{policy_v1, AgentMetrics, CreditDecision};

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Exposure,
    Agents,
    KeysByPubkey,
    Disputes,
}

/// Public, JSON-facing record of an authorized agent. Mirrors `CreditDecision`
/// plus the identity/key bookkeeping needed to look an agent up by its live
/// spend key.
#[near(serializers=[borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AgentRecord {
    pub agent_id: String,
    /// Identity sub-account (`agent-<id>.<this-contract>`) — branding/bookkeeping only.
    pub sub_account: AccountId,
    pub public_key: PublicKey,
    pub credit_line: U128,
    pub credit_score: u64,
    pub interest_rate_bps: u64,
    pub policy_version: u8,
    /// False once `scam_detection` has revoked this agent's spend key.
    pub key_active: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct SpendGuard {
    admin: AccountId,
    exposure: exposure::ExposureBook,
    agents: LookupMap<String, AgentRecord>,
    keys_by_pubkey: LookupMap<PublicKey, String>,
    disputes: LookupMap<String, u64>,
}

#[near]
impl SpendGuard {
    #[init]
    pub fn new(admin: AccountId) -> Self {
        Self {
            admin,
            exposure: exposure::ExposureBook::new(StorageKey::Exposure),
            agents: LookupMap::new(StorageKey::Agents),
            keys_by_pubkey: LookupMap::new(StorageKey::KeysByPubkey),
            disputes: LookupMap::new(StorageKey::Disputes),
        }
    }

    /// Day 3's core new primitive: evaluate policy -> reserve exposure ->
    /// create/reuse the agent's identity sub-account -> mint a Function Call
    /// Access Key whose allowance equals the approved credit line. Returns a
    /// `Promise` joining both on-chain effects (sub-account creation and key
    /// issuance); callers read the resulting `AgentRecord` back via
    /// `get_agent` once it resolves.
    pub fn request_spend_authorization(
        &mut self,
        agent_id: String,
        metrics: AgentMetrics,
        public_key: PublicKey,
    ) -> Promise {
        // Admin/operator-only: `metrics` is caller-supplied, and this method
        // spends out of the contract's own pooled balance (identity
        // sub-account funding) and lets the agent draw on it later — so it
        // must only ever be called by the operator who has independently
        // verified the agent's real x402 revenue server-side (reading
        // `near_payment_attempt_store.ts`'s finalized receipts), never by an
        // arbitrary caller self-declaring fake metrics for a free credit
        // line. This is the AI-Security-relevant guard: without it, anyone
        // could mint themselves a spend key against invented revenue.
        self.only_admin();
        require!(!agent_id.is_empty(), "agent_id must not be empty");

        // Idempotency guard (Day 10): an agent with a live key cannot be
        // re-authorized out from under itself — mirrors
        // near_payment_attempt_store.ts's claim-once-per-key pattern.
        if let Some(existing) = self.agents.get(&agent_id) {
            require!(
                !existing.key_active,
                "agent already has a live spend key; wait for it to be revoked or exhausted before re-authorizing"
            );
        }

        let decision = policy::policy_v1(&metrics);
        require!(decision.credit_line.0 > 0, "policy evaluation produced a zero credit line");

        self.exposure.ensure_agent(&agent_id, decision.credit_line.0);
        self.exposure.reserve_exposure(&agent_id, decision.credit_line.0);

        let sub_account = spend_key::identity_subaccount_id(&agent_id);

        let record = AgentRecord {
            agent_id: agent_id.clone(),
            sub_account: sub_account.clone(),
            public_key: public_key.clone(),
            credit_line: decision.credit_line,
            credit_score: decision.credit_score,
            interest_rate_bps: decision.interest_rate_bps,
            policy_version: decision.policy_version,
            key_active: true,
        };
        self.agents.insert(agent_id.clone(), record);
        self.keys_by_pubkey.insert(public_key.clone(), agent_id);

        // Both promises are scheduled as soon as these builder calls run (the
        // underlying host functions fire immediately, not lazily on return),
        // so the identity sub-account genuinely gets created+funded even
        // though only the key-minting promise below is this function's
        // return value — NEAR prohibits returning a joint/`.and()`-ed
        // promise directly from a function call ("Returning joint promise is
        // currently prohibited"), so the two must stay independent receipts
        // rather than being combined into one returned value.
        let _identity = spend_key::create_identity_subaccount(sub_account);
        spend_key::mint_spend_key(public_key, decision.credit_line.0)
    }

    /// The only entrypoint a scoped spend key may ever call (see
    /// `spend_key::SPEND_METHOD`). Looks the caller up by the REAL public
    /// key nearcore recorded as having signed this transaction
    /// (`env::signer_account_pk`) — not a client-supplied claim — so a
    /// spoofed `agent_id` cannot borrow another agent's exposure headroom.
    ///
    /// Takes `amount` as a plain argument rather than an attached deposit —
    /// a real NEAR protocol constraint discovered while building this
    /// (`InvalidAccessKeyError::DepositWithFunctionCall`, confirmed against
    /// a live local nearcore node, see `tests/sandbox.rs`): a Function Call
    /// Access Key is categorically forbidden from attaching ANY deposit to
    /// its one allowed action, regardless of its allowance. Its allowance
    /// instead caps the GAS cost this key may ever prepay — a real,
    /// protocol-enforced budget on how many authorized calls the key can
    /// make, which this method's own `ExposureBook` check layers the actual
    /// yoctoNEAR spending cap on top of (ported 1:1 from
    /// `GlobalExposureManager`, see `exposure.rs`). The NEAR this call
    /// forwards is this contract's OWN pooled balance, not the caller's —
    /// exactly the plan's documented fallback for when the key-allowance
    /// flow proves awkward in practice: "the Function Call Key allowance as
    /// an additional, not sole, enforcement layer."
    pub fn spend_to_seller(&mut self, seller_id: AccountId, amount: U128) -> Promise {
        let signer_pk = env::signer_account_pk();
        let agent_id = self
            .keys_by_pubkey
            .get(&signer_pk)
            .cloned()
            .unwrap_or_else(|| env::panic_str("this key is not a known SpendGuard spend key"));

        let record = self.agents.get(&agent_id).cloned().expect("agent record missing for a known key");
        require!(record.key_active, "this agent's spend key has been revoked");

        let exposure = self.exposure.get(&agent_id).expect("exposure record missing for a known agent");
        require!(!exposure.frozen, "this agent's exposure is frozen by the circuit breaker");
        require!(amount.0 > 0, "spend_to_seller requires a positive amount");
        require!(
            amount.0 <= exposure.reserved.0,
            "requested spend exceeds the agent's remaining reserved credit line"
        );

        self.exposure.activate_exposure(&agent_id, amount.0);
        env::log_str(&format!("spend_guard: agent {} spent {} yoctoNEAR to {}", agent_id, amount.0, seller_id));
        Promise::new(seller_id).transfer(near_sdk::NearToken::from_yoctonear(amount.0))
    }

    /// Admin-only: record a real repayment against `agent_id`'s outstanding
    /// draw, reducing its global exposure by `amount` — the missing other
    /// half of `spend_to_seller`'s draw-down, which is what turns the
    /// approved `credit_line` from a one-shot budget into an actual
    /// revolving credit line (the whole premise of a "credit score" for an
    /// agent: it can draw, repay, and draw again against the same
    /// underwritten line, not spend once and be done). Same trust model as
    /// `request_spend_authorization`'s `metrics` argument — the admin has
    /// independently verified a real repayment happened (e.g. against the
    /// agent's own later x402 revenue) server-side before calling this;
    /// this method itself moves no funds, it only updates the ledger an
    /// agent's future `request_spend_authorization` calls are checked
    /// against. Capped at the agent's current `outstanding` by
    /// `ExposureBook::decrease_exposure` (never goes negative), so an
    /// over-reported repayment cannot manufacture exposure headroom beyond
    /// what was actually drawn.
    pub fn repay_credit_line(&mut self, agent_id: String, amount: U128) {
        self.only_admin();
        require!(amount.0 > 0, "repay_credit_line requires a positive amount");
        self.exposure.decrease_exposure(&agent_id, amount.0);
        env::log_str(&format!("spend_guard: agent {} repaid {} yoctoNEAR against its outstanding exposure", agent_id, amount.0));
    }

    /// Admin/watchdog-only (Day 6): record `count` additional disputes
    /// against `agent_id`. Crossing `scam_detection::DISPUTE_SPIKE_THRESHOLD`
    /// freezes the agent's exposure AND schedules a real `delete_key`
    /// promise for its live spend key, independent of remaining allowance.
    pub fn report_dispute_spike(&mut self, agent_id: String, count: u64) -> Option<Promise> {
        self.only_admin();
        let public_key = self.agents.get(&agent_id).map(|r| r.public_key.clone());
        let promise = scam_detection::record_dispute_spike(
            &mut self.exposure,
            &mut self.disputes,
            &agent_id,
            count,
            public_key,
        );
        if promise.is_some() {
            if let Some(mut record) = self.agents.get(&agent_id).cloned() {
                record.key_active = false;
                self.agents.insert(agent_id, record);
            }
        }
        promise
    }

    /// Admin-only emergency freeze, bypassing the dispute-count threshold
    /// entirely (an explicit fraud signal rather than an accumulated spike).
    pub fn emergency_freeze(&mut self, agent_id: String) -> Promise {
        self.only_admin();
        let mut record = self.agents.get(&agent_id).cloned().expect("unknown agent_id");
        require!(record.key_active, "agent's key is already revoked");
        let promise = scam_detection::emergency_freeze(&mut self.exposure, &agent_id, record.public_key.clone());
        record.key_active = false;
        self.agents.insert(agent_id, record);
        promise
    }

    // ---- views ----

    pub fn get_agent(&self, agent_id: String) -> Option<AgentRecord> {
        self.agents.get(&agent_id).cloned()
    }

    pub fn get_exposure(&self, agent_id: String) -> Option<AgentExposure> {
        self.exposure.get(&agent_id)
    }

    pub fn get_dispute_count(&self, agent_id: String) -> u64 {
        self.disputes.get(&agent_id).copied().unwrap_or(0)
    }

    /// Day 10: how much of the agent's approved credit line is still
    /// unspent — `reserved` (the portion of the original reservation not
    /// yet moved into `outstanding` by a real `spend_to_seller` call, nor
    /// released back by a freeze). `outstanding + reserved` was constant
    /// (equal to the original reservation) right after
    /// `request_spend_authorization` reserved the full line up front — but
    /// is no longer an invariant once `repay_credit_line` (reduces
    /// `outstanding` alone) or a freeze's reservation release (reduces
    /// `reserved` alone) have run, so don't assume it holds generally.
    /// `reserved` alone is still the correct "budget left to spend" signal
    /// either way. This is a contract-state-level proxy for "remaining
    /// allowance"; nearcore's own per-key allowance counter is not readable
    /// from contract code, only enforced by it.
    pub fn remaining_allowance(&self, agent_id: String) -> Option<U128> {
        self.exposure.get(&agent_id).map(|e| e.reserved)
    }

    pub fn admin(&self) -> AccountId {
        self.admin.clone()
    }

    fn only_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "admin only");
    }
}
