#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! AgentCreditPool — the DeFi pool. LPs deposit CSPR; high-scoring agents draw
//! working capital against verified x402 cash flow and repay with interest.
//! Mirrors `lib/ledger/contracts/agent_credit_pool.ts`.

extern crate alloc;

use odra::casper_types::U512;
use odra::prelude::*;

#[odra::odra_type]
pub struct CreditLine {
    pub agent_id: String,
    pub max_credit: U512,
    pub drawn: U512,
    pub interest_rate_bps: u64,
    pub opened_at: u64,
    pub due_timestamp: u64,
    /// 0 active, 1 frozen, 2 defaulted.
    pub status: u8,
}

#[odra::event]
pub struct LiquidityDeposited {
    pub provider: Address,
    pub amount: U512,
    pub total_liquidity: U512,
}

#[odra::event]
pub struct CreditLineOpened {
    pub agent_id: String,
    pub max_credit: U512,
    pub interest_rate_bps: u64,
    pub due_timestamp: u64,
}

#[odra::event]
pub struct CreditDrawn {
    pub agent_id: String,
    pub amount: U512,
    pub drawn: U512,
}

#[odra::event]
pub struct CreditRepaid {
    pub agent_id: String,
    pub principal: U512,
    pub interest: U512,
    pub remaining: U512,
}

#[odra::event]
pub struct CreditFrozen {
    pub agent_id: String,
    pub reason: String,
}

#[odra::module(events = [LiquidityDeposited, CreditLineOpened, CreditDrawn, CreditRepaid, CreditFrozen])]
pub struct AgentCreditPool {
    lines: Mapping<String, CreditLine>,
    total_liquidity: Var<U512>,
    outstanding_credit: Var<U512>,
    interest_accrued: Var<U512>,
    defaults: Var<u64>,
    admin: Var<Address>,
}

#[odra::module]
impl AgentCreditPool {
    pub fn init(&mut self) {
        self.total_liquidity.set(U512::zero());
        self.outstanding_credit.set(U512::zero());
        self.interest_accrued.set(U512::zero());
        self.defaults.set(0);
        self.admin.set(self.env().caller());
    }

    #[odra(payable)]
    pub fn deposit_liquidity(&mut self) {
        let amount = self.env().attached_value();
        if amount.is_zero() {
            self.env().revert(Error::ZeroDeposit);
        }
        let total = self.total_liquidity.get_or_default() + amount;
        self.total_liquidity.set(total);
        self.env().emit_event(LiquidityDeposited {
            provider: self.env().caller(),
            amount,
            total_liquidity: total,
        });
    }

    pub fn open_credit_line(
        &mut self,
        agent_id: String,
        max_credit: U512,
        interest_rate_bps: u64,
        term_seconds: u64,
    ) {
        self.only_admin();
        let now = self.env().get_block_time();
        let drawn = self
            .lines
            .get(&agent_id)
            .map(|l| l.drawn)
            .unwrap_or_else(U512::zero);
        let line = CreditLine {
            agent_id: agent_id.clone(),
            max_credit,
            drawn,
            interest_rate_bps,
            opened_at: now,
            due_timestamp: now + term_seconds,
            status: 0,
        };
        self.lines.set(&agent_id, line);
        self.env().emit_event(CreditLineOpened {
            agent_id,
            max_credit,
            interest_rate_bps,
            due_timestamp: now + term_seconds,
        });
    }

    pub fn draw(&mut self, agent_id: String, amount: U512) {
        let mut line = self.must(&agent_id);
        if line.status != 0 {
            self.env().revert(Error::LineNotActive);
        }
        if line.drawn + amount > line.max_credit {
            self.env().revert(Error::ExceedsMaxCredit);
        }
        let free = self.total_liquidity.get_or_default() - self.outstanding_credit.get_or_default();
        if amount > free {
            self.env().revert(Error::InsufficientLiquidity);
        }
        line.drawn += amount;
        let drawn = line.drawn;
        self.lines.set(&agent_id, line);
        self.outstanding_credit
            .set(self.outstanding_credit.get_or_default() + amount);
        // Transfer the drawn working capital to the agent's account.
        self.env().transfer_tokens(&self.env().caller(), &amount);
        self.env().emit_event(CreditDrawn {
            agent_id,
            amount,
            drawn,
        });
    }

    /// Repay principal + accrued interest (attached CSPR). Interest compounds to LPs.
    #[odra(payable)]
    pub fn repay(&mut self, agent_id: String) {
        let amount = self.env().attached_value();
        let mut line = self.must(&agent_id);
        let interest = self.accrued_interest(&line);
        let interest_paid = if amount > interest { interest } else { amount };
        let principal = amount - interest_paid;
        let principal = if principal > line.drawn {
            line.drawn
        } else {
            principal
        };

        line.drawn -= principal;
        let remaining = line.drawn;
        self.lines.set(&agent_id, line);
        self.outstanding_credit
            .set(self.outstanding_credit.get_or_default() - principal);
        self.interest_accrued
            .set(self.interest_accrued.get_or_default() + interest_paid);
        self.total_liquidity
            .set(self.total_liquidity.get_or_default() + interest_paid);
        self.env().emit_event(CreditRepaid {
            agent_id,
            principal,
            interest: interest_paid,
            remaining,
        });
    }

    pub fn freeze(&mut self, agent_id: String, reason: String) {
        self.only_admin();
        if let Some(mut line) = self.lines.get(&agent_id) {
            line.status = 1;
            self.lines.set(&agent_id, line);
            self.env().emit_event(CreditFrozen { agent_id, reason });
        }
    }

    pub fn liquidate(&mut self, agent_id: String) {
        self.only_admin();
        let mut line = self.must(&agent_id);
        let loss = line.drawn;
        line.status = 2;
        self.lines.set(&agent_id, line);
        self.outstanding_credit
            .set(self.outstanding_credit.get_or_default() - loss);
        self.total_liquidity
            .set(self.total_liquidity.get_or_default() - loss);
        self.defaults.set(self.defaults.get_or_default() + 1);
    }

    pub fn accrued_interest(&self, line: &CreditLine) -> U512 {
        if line.drawn.is_zero() {
            return U512::zero();
        }
        let elapsed = self.env().get_block_time().saturating_sub(line.opened_at);
        let year: u64 = 365 * 24 * 60 * 60;
        // drawn * bps/10000 * elapsed/year
        line.drawn * U512::from(line.interest_rate_bps) * U512::from(elapsed)
            / (U512::from(10000u64) * U512::from(year))
    }

    pub fn get_line(&self, agent_id: String) -> Option<CreditLine> {
        self.lines.get(&agent_id)
    }

    pub fn total_liquidity(&self) -> U512 {
        self.total_liquidity.get_or_default()
    }

    pub fn outstanding_credit(&self) -> U512 {
        self.outstanding_credit.get_or_default()
    }

    fn must(&self, agent_id: &str) -> CreditLine {
        self.lines
            .get(&agent_id.to_string())
            .unwrap_or_revert_with(&self.env(), Error::NoCreditLine)
    }

    fn only_admin(&self) {
        if self.env().caller() != self.admin.get_or_revert_with(Error::NotInitialized) {
            self.env().revert(Error::Unauthorized);
        }
    }
}

#[odra::odra_error]
pub enum Error {
    ZeroDeposit = 1,
    LineNotActive = 2,
    ExceedsMaxCredit = 3,
    InsufficientLiquidity = 4,
    NoCreditLine = 5,
    Unauthorized = 6,
    NotInitialized = 7,
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, HostEnv, HostRef, NoArgs};

    const CSPR: u64 = 1_000_000_000;

    fn deploy() -> (HostEnv, AgentCreditPoolHostRef) {
        let env = odra_test::env();
        let pool = AgentCreditPool::deploy(&env, NoArgs);
        (env, pool)
    }

    #[test]
    fn deposit_open_draw_repay_flow() {
        let (_env, mut pool) = deploy();
        pool.with_tokens(U512::from(1000 * CSPR))
            .deposit_liquidity();
        assert_eq!(pool.total_liquidity(), U512::from(1000 * CSPR));

        pool.open_credit_line("a1".to_string(), U512::from(40 * CSPR), 900, 7 * 24 * 3600);
        pool.draw("a1".to_string(), U512::from(6 * CSPR));
        assert_eq!(pool.outstanding_credit(), U512::from(6 * CSPR));
        assert_eq!(
            pool.get_line("a1".to_string()).unwrap().drawn,
            U512::from(6 * CSPR)
        );

        pool.with_tokens(U512::from(6 * CSPR))
            .repay("a1".to_string());
        assert_eq!(pool.get_line("a1".to_string()).unwrap().drawn, U512::zero());
        assert_eq!(pool.outstanding_credit(), U512::zero());
    }

    #[test]
    fn draw_cannot_exceed_max_credit() {
        let (_env, mut pool) = deploy();
        pool.with_tokens(U512::from(1000 * CSPR))
            .deposit_liquidity();
        pool.open_credit_line("a1".to_string(), U512::from(10 * CSPR), 900, 7 * 24 * 3600);
        assert!(pool
            .try_draw("a1".to_string(), U512::from(11 * CSPR))
            .is_err());
    }

    #[test]
    fn draw_cannot_exceed_pool_liquidity() {
        let (_env, mut pool) = deploy();
        pool.with_tokens(U512::from(5 * CSPR)).deposit_liquidity();
        pool.open_credit_line("a1".to_string(), U512::from(100 * CSPR), 900, 7 * 24 * 3600);
        assert!(pool
            .try_draw("a1".to_string(), U512::from(6 * CSPR))
            .is_err());
    }

    #[test]
    fn frozen_line_blocks_draw() {
        let (_env, mut pool) = deploy();
        pool.with_tokens(U512::from(1000 * CSPR))
            .deposit_liquidity();
        pool.open_credit_line("a1".to_string(), U512::from(40 * CSPR), 900, 7 * 24 * 3600);
        pool.freeze("a1".to_string(), "risk".to_string());
        assert!(pool
            .try_draw("a1".to_string(), U512::from(1 * CSPR))
            .is_err());
    }

    #[test]
    fn liquidation_records_a_default_and_loss() {
        let (_env, mut pool) = deploy();
        pool.with_tokens(U512::from(1000 * CSPR))
            .deposit_liquidity();
        pool.open_credit_line("a1".to_string(), U512::from(40 * CSPR), 900, 7 * 24 * 3600);
        pool.draw("a1".to_string(), U512::from(8 * CSPR));
        pool.liquidate("a1".to_string());
        assert_eq!(pool.get_line("a1".to_string()).unwrap().status, 2);
        assert_eq!(pool.total_liquidity(), U512::from(992 * CSPR));
        assert_eq!(pool.outstanding_credit(), U512::zero());
    }

    #[test]
    fn interest_accrues_over_time() {
        let (env, mut pool) = deploy();
        pool.with_tokens(U512::from(1000 * CSPR))
            .deposit_liquidity();
        pool.open_credit_line(
            "a1".to_string(),
            U512::from(100 * CSPR),
            1000,
            365 * 24 * 3600,
        );
        pool.draw("a1".to_string(), U512::from(100 * CSPR));
        env.advance_block_time(365 * 24 * 3600); // one year
        let line = pool.get_line("a1".to_string()).unwrap();
        // 10% APR on 100 CSPR for a year ≈ 10 CSPR.
        assert_eq!(pool.accrued_interest(&line), U512::from(10 * CSPR));
    }
}
