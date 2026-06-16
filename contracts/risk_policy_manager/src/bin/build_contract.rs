#![doc = "Binary for building wasm files from odra contracts."]
#![no_std]
#![cfg_attr(target_arch = "wasm32", no_main)]
#![allow(unused_imports, clippy::single_component_path_imports)]
use risk_policy_manager;

#[cfg(not(target_arch = "wasm32"))]
fn main() {}
