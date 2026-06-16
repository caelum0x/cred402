//! Livenet deployer for RWAAssetRegistry — deploys to Casper Testnet via Odra 2.x.
use rwa_asset_registry::RWAAssetRegistry;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(300_000_000_000u64);
    let contract = RWAAssetRegistry::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED rwa_asset_registry {}", contract.address().to_string());
}
