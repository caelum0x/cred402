//! Livenet deployer for AgentPassport — deploys to Casper Testnet via Odra 2.x.
use agent_passport::AgentPassport;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(300_000_000_000u64);
    let contract = AgentPassport::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED agent_passport {}", contract.address().to_string());
}
