#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! AgentPassport (p2 §6.2) — a read-optimized public trust profile. The
//! AgentRegistry is canonical; the passport stores the integration surface
//! (capabilities, spending limit, operator) other protocols read. Mirrors
//! `lib/ledger/contracts/agent_passport.ts`.

extern crate alloc;

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::odra_type]
pub struct Passport {
    pub agent_id: String,
    pub service_type: String,
    pub operator: String,
    pub capabilities: Vec<String>,
    pub spending_limit: U512,
}

#[odra::event]
pub struct PassportUpdated {
    pub agent_id: String,
}

#[odra::module(events = [PassportUpdated])]
pub struct AgentPassport {
    passports: Mapping<String, Passport>,
}

#[odra::module]
impl AgentPassport {
    pub fn init(&mut self) {}

    pub fn set_profile(
        &mut self,
        agent_id: String,
        service_type: String,
        operator: String,
        capabilities: Vec<String>,
        spending_limit: U512,
    ) {
        let passport = Passport {
            agent_id: agent_id.clone(),
            service_type,
            operator,
            capabilities,
            spending_limit,
        };
        self.passports.set(&agent_id, passport);
        self.env().emit_event(PassportUpdated { agent_id });
    }

    pub fn get_passport(&self, agent_id: String) -> Option<Passport> {
        self.passports.get(&agent_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, AgentPassportHostRef) {
        let env = odra_test::env();
        let passport = AgentPassport::deploy(&env, NoArgs);
        (env, passport)
    }

    #[test]
    fn stores_and_reads_a_public_profile() {
        let (_env, mut passport) = deploy();
        passport.set_profile(
            "a1".to_string(),
            "rwa.energy".to_string(),
            "0203operator".to_string(),
            vec!["x402.sell".to_string(), "evidence.submit".to_string()],
            U512::from(15_000u64),
        );
        let p = passport.get_passport("a1".to_string()).expect("exists");
        assert_eq!(p.service_type, "rwa.energy");
        assert_eq!(p.capabilities.len(), 2);
        assert_eq!(p.spending_limit, U512::from(15_000u64));
        assert!(passport.get_passport("missing".to_string()).is_none());
    }

    #[test]
    fn set_profile_overwrites_immutably() {
        let (_env, mut passport) = deploy();
        passport.set_profile(
            "a1".to_string(),
            "svc".to_string(),
            "op".to_string(),
            vec![],
            U512::from(1u64),
        );
        passport.set_profile(
            "a1".to_string(),
            "svc2".to_string(),
            "op".to_string(),
            vec!["c".to_string()],
            U512::from(2u64),
        );
        let p = passport.get_passport("a1".to_string()).unwrap();
        assert_eq!(p.service_type, "svc2");
        assert_eq!(p.capabilities, vec!["c".to_string()]);
    }
}
