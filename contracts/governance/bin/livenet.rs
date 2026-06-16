//! Livenet deployer for Governance — deploys to Casper Testnet via Odra 2.x.
use governance::Governance;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(650_000_000_000u64);
    let contract = Governance::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED governance {}", contract.address().to_string());
}
