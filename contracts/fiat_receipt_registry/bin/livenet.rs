//! Livenet deployer for FiatReceiptRegistry — deploys to Casper Testnet via Odra 2.x.
use fiat_receipt_registry::FiatReceiptRegistry;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(500_000_000_000u64);
    let contract = FiatReceiptRegistry::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED fiat_receipt_registry {}", contract.address().to_string());
}
