//! Livenet deployer for RealFiAttestationRegistry — deploys to Casper Testnet via Odra 2.x.
use realfi_attestation_registry::RealFiAttestationRegistry;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(500_000_000_000u64);
    let contract = RealFiAttestationRegistry::deploy(&env, NoArgs);
    println!("CRED402_DEPLOYED realfi_attestation_registry {}", contract.address().to_string());
}
