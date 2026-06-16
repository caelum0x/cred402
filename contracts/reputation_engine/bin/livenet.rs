//! Livenet deployer for ReputationEngine — deploys to Casper Testnet via Odra 2.x.
use reputation_engine::ReputationEngine;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(300_000_000_000u64);
    let contract = ReputationEngine::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED reputation_engine {}", contract.address().to_string());
}
