#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! Governance (p2 §6.11) — controls protocol parameters, fees and emergency
//! pause flags with a public parameter history. Mirrors
//! `lib/ledger/contracts/governance.ts`.

extern crate alloc;

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::odra_type]
pub struct GovernanceParams {
    pub protocol_fee_bps: u64,
    pub origination_fee_bps: u64,
    pub min_reputation_to_draw: u64,
    pub max_agent_exposure: U512,
    pub dispute_window_seconds: u64,
    pub paused_credit_draws: bool,
    pub paused_registrations: bool,
    pub paused_receipt_finalization: bool,
}

#[odra::event]
pub struct GovernanceParameterUpdated {
    pub key: String,
    pub previous: String,
    pub next: String,
}

#[odra::event]
pub struct ProtocolPaused {
    pub area: String,
}

#[odra::event]
pub struct ProtocolUnpaused {
    pub area: String,
}

#[odra::module(events = [GovernanceParameterUpdated, ProtocolPaused, ProtocolUnpaused])]
pub struct Governance {
    params: Var<GovernanceParams>,
    admin: Var<Address>,
}

#[odra::module]
impl Governance {
    pub fn init(&mut self) {
        self.params.set(GovernanceParams {
            protocol_fee_bps: 50,
            origination_fee_bps: 100,
            min_reputation_to_draw: 40,
            max_agent_exposure: U512::from(500_000_000_000u64), // 500 CSPR
            dispute_window_seconds: 86_400,
            paused_credit_draws: false,
            paused_registrations: false,
            paused_receipt_finalization: false,
        });
        self.admin.set(self.env().caller());
    }

    pub fn get_params(&self) -> GovernanceParams {
        self.params.get_or_revert_with(Error::NotInitialized)
    }

    pub fn set_fee(&mut self, protocol_fee_bps: u64, origination_fee_bps: u64) {
        self.only_admin();
        let mut p = self.get_params();
        let prev = format!("{}/{}", p.protocol_fee_bps, p.origination_fee_bps);
        p.protocol_fee_bps = protocol_fee_bps;
        p.origination_fee_bps = origination_fee_bps;
        let next = format!("{}/{}", protocol_fee_bps, origination_fee_bps);
        self.params.set(p);
        self.env().emit_event(GovernanceParameterUpdated {
            key: String::from("fees"),
            previous: prev,
            next,
        });
    }

    pub fn set_min_reputation(&mut self, min_reputation_to_draw: u64) {
        self.only_admin();
        let mut p = self.get_params();
        let prev = p.min_reputation_to_draw.to_string();
        p.min_reputation_to_draw = min_reputation_to_draw;
        self.params.set(p);
        self.env().emit_event(GovernanceParameterUpdated {
            key: String::from("min_reputation_to_draw"),
            previous: prev,
            next: min_reputation_to_draw.to_string(),
        });
    }

    pub fn pause_credit_draws(&mut self, paused: bool) {
        self.only_admin();
        let mut p = self.get_params();
        p.paused_credit_draws = paused;
        self.params.set(p);
        let area = String::from("credit_draws");
        if paused {
            self.env().emit_event(ProtocolPaused { area });
        } else {
            self.env().emit_event(ProtocolUnpaused { area });
        }
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    Unauthorized = 1,
    NotInitialized = 2,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, GovernanceHostRef) {
        let env = odra_test::env();
        let gov = Governance::deploy(&env, NoArgs);
        (env, gov)
    }

    #[test]
    fn initializes_with_sane_defaults() {
        let (_env, gov) = deploy();
        let p = gov.get_params();
        assert_eq!(p.protocol_fee_bps, 50);
        assert_eq!(p.origination_fee_bps, 100);
        assert_eq!(p.min_reputation_to_draw, 40);
        assert!(!p.paused_credit_draws);
    }

    #[test]
    fn admin_can_update_fees_and_pause() {
        let (_env, mut gov) = deploy();
        gov.set_fee(75, 150);
        gov.set_min_reputation(55);
        gov.pause_credit_draws(true);
        let p = gov.get_params();
        assert_eq!(p.protocol_fee_bps, 75);
        assert_eq!(p.origination_fee_bps, 150);
        assert_eq!(p.min_reputation_to_draw, 55);
        assert!(p.paused_credit_draws);
    }

    #[test]
    fn parameter_changes_are_admin_only() {
        let (env, mut gov) = deploy();
        let intruder = env.get_account(1);
        env.set_caller(intruder);
        assert!(gov.try_set_fee(0, 0).is_err());
        assert!(gov.try_pause_credit_draws(true).is_err());
    }
}
