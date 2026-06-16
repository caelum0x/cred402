//! Livenet deployer for OperatorVerificationRegistry — deploys to Casper Testnet via Odra 2.x.
use operator_verification_registry::OperatorVerificationRegistry;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(500_000_000_000u64);
    let contract = OperatorVerificationRegistry::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED operator_verification_registry {}", contract.address().to_string());
}
