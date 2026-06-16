//! Livenet deployer for SlashingVault — deploys to Casper Testnet via Odra 2.x.
use slashing_vault::SlashingVault;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(350_000_000_000u64);
    let contract = SlashingVault::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED slashing_vault {}", contract.address().to_string());
}
