//! Livenet deployer for DisputeCourt — deploys to Casper Testnet via Odra 2.x.
use dispute_court::DisputeCourt;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(450_000_000_000u64);
    let contract = DisputeCourt::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED dispute_court {}", contract.address().to_string());
}
