//! Livenet deployer for X402ReceiptRegistry — deploys to Casper Testnet via Odra 2.x.
use x402_receipt_registry::X402ReceiptRegistry;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(300_000_000_000u64);
    let contract = X402ReceiptRegistry::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED x402_receipt_registry {}", contract.address().to_string());
}
