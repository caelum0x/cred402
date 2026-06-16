#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! SlashingVault (p2 §6.10) — receives slashed stake and distributes it across
//! destinations (victim reimbursement, insurance reserve, protocol treasury,
//! burn). Mirrors `lib/ledger/contracts/slashing_vault.ts`.

extern crate alloc;

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::odra_type]
pub struct SlashRecord {
    pub slash_id: String,
    pub agent_id: String,
    pub amount: U512,
    pub reason: String,
    pub dispute_id: String,
    pub to_victim: U512,
    pub to_insurance: U512,
    pub to_treasury: U512,
    pub to_burn: U512,
    pub timestamp: u64,
}

#[odra::event]
pub struct StakeSlashedToVault {
    pub slash_id: String,
    pub agent_id: String,
    pub amount: U512,
    pub dispute_id: String,
}

#[odra::module(events = [StakeSlashedToVault])]
pub struct SlashingVault {
    records: Mapping<String, SlashRecord>,
    victim_reserve: Var<U512>,
    insurance_reserve: Var<U512>,
    treasury_reserve: Var<U512>,
    burned: Var<U512>,
    admin: Var<Address>,
}

#[odra::module]
impl SlashingVault {
    pub fn init(&mut self) {
        self.victim_reserve.set(U512::zero());
        self.insurance_reserve.set(U512::zero());
        self.treasury_reserve.set(U512::zero());
        self.burned.set(U512::zero());
        self.admin.set(self.env().caller());
    }

    /// Apply a slash with a basis-point split (must sum to 10000).
    pub fn apply_slash(
        &mut self,
        slash_id: String,
        agent_id: String,
        amount: U512,
        reason: String,
        dispute_id: String,
        victim_bps: u64,
        insurance_bps: u64,
        treasury_bps: u64,
        burn_bps: u64,
    ) {
        self.only_admin();
        if victim_bps + insurance_bps + treasury_bps + burn_bps != 10000 {
            self.env().revert(Error::BadSplit);
        }
        let to_victim = amount * U512::from(victim_bps) / U512::from(10000u64);
        let to_insurance = amount * U512::from(insurance_bps) / U512::from(10000u64);
        let to_burn = amount * U512::from(burn_bps) / U512::from(10000u64);
        // treasury absorbs rounding dust
        let to_treasury = amount - to_victim - to_insurance - to_burn;

        self.victim_reserve
            .set(self.victim_reserve.get_or_default() + to_victim);
        self.insurance_reserve
            .set(self.insurance_reserve.get_or_default() + to_insurance);
        self.treasury_reserve
            .set(self.treasury_reserve.get_or_default() + to_treasury);
        self.burned.set(self.burned.get_or_default() + to_burn);

        let record = SlashRecord {
            slash_id: slash_id.clone(),
            agent_id: agent_id.clone(),
            amount,
            reason,
            dispute_id: dispute_id.clone(),
            to_victim,
            to_insurance,
            to_treasury,
            to_burn,
            timestamp: self.env().get_block_time(),
        };
        self.records.set(&slash_id, record);
        self.env().emit_event(StakeSlashedToVault {
            slash_id,
            agent_id,
            amount,
            dispute_id,
        });
    }

    pub fn get_record(&self, slash_id: String) -> Option<SlashRecord> {
        self.records.get(&slash_id)
    }

    pub fn insurance_reserve(&self) -> U512 {
        self.insurance_reserve.get_or_default()
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    BadSplit = 1,
    Unauthorized = 2,
    NotInitialized = 3,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, NoArgs};

    fn deploy() -> (HostEnv, SlashingVaultHostRef) {
        let env = odra_test::env();
        let vault = SlashingVault::deploy(&env, NoArgs);
        (env, vault)
    }

    #[test]
    fn distributes_a_slash_across_destinations() {
        let (_env, mut vault) = deploy();
        // 100 split 50/30/15/5 → victim 50, insurance 30, treasury 15, burn 5
        vault.apply_slash(
            "s1".to_string(),
            "a1".to_string(),
            U512::from(100u64),
            "false_evidence".to_string(),
            "d1".to_string(),
            5000,
            3000,
            1500,
            500,
        );
        let r = vault.get_record("s1".to_string()).unwrap();
        assert_eq!(r.to_victim, U512::from(50u64));
        assert_eq!(r.to_insurance, U512::from(30u64));
        assert_eq!(r.to_treasury, U512::from(15u64));
        assert_eq!(r.to_burn, U512::from(5u64));
        assert_eq!(vault.insurance_reserve(), U512::from(30u64));
        // splits sum to the slashed amount exactly (treasury absorbs dust)
        assert_eq!(
            r.to_victim + r.to_insurance + r.to_treasury + r.to_burn,
            U512::from(100u64)
        );
    }

    #[test]
    fn rejects_a_split_that_does_not_sum_to_10000() {
        let (_env, mut vault) = deploy();
        assert!(vault
            .try_apply_slash(
                "s1".to_string(),
                "a1".to_string(),
                U512::from(100u64),
                "r".to_string(),
                "d1".to_string(),
                5000,
                3000,
                1500,
                1000
            )
            .is_err());
    }

    #[test]
    fn slashing_is_admin_only() {
        let (env, mut vault) = deploy();
        let intruder = env.get_account(1);
        env.set_caller(intruder);
        assert!(vault
            .try_apply_slash(
                "s1".to_string(),
                "a1".to_string(),
                U512::from(100u64),
                "r".to_string(),
                "d1".to_string(),
                10000,
                0,
                0,
                0
            )
            .is_err());
    }
}
