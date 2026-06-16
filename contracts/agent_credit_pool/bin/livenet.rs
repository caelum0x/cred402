//! Livenet deployer for AgentCreditPool — deploys to Casper Testnet via Odra 2.x.
use agent_credit_pool::AgentCreditPool;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(650_000_000_000u64);
    let contract = AgentCreditPool::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED agent_credit_pool {}", contract.address().to_string());
}
