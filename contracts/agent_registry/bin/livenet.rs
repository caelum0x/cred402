//! Livenet deployer for AgentRegistry — deploys the real contract to Casper
//! Testnet via Odra's own host API (correct install args, signing, settlement).
//!
//!   ODRA_CASPER_LIVENET_SECRET_KEY_PATH=../../.secrets/testnet_deployer.pem \
//!   ODRA_CASPER_LIVENET_NODE_ADDRESS=https://node.testnet.casper.network/rpc \
//!   ODRA_CASPER_LIVENET_CHAIN_NAME=casper-test \
//!   cargo run --bin livenet --features livenet
use agent_registry::AgentRegistry;
use odra::host::{Deployer, NoArgs};
use odra::prelude::Addressable;
use odra_casper_livenet_env::env;

fn main() {
    let env = env();
    env.set_gas(400_000_000_000u64);
    let contract = AgentRegistry::deploy(&env, NoArgs);
    println!("AGENT_REGISTRY_ADDRESS={}", contract.address().to_string());
}
