#!/usr/bin/env python3
"""Add the Odra 2.x wasm-build + livenet-deploy scaffolding to a contract crate.

Usage: python3 scaffold_livenet.py <crate> <StructName> [gas_cspr]
Idempotent-ish: rewrites Cargo.toml, build.rs, Odra.toml, src/bin/build_contract.rs,
bin/livenet.rs, and ensures the no_std header in src/lib.rs.
"""
import sys, os, re

crate, struct = sys.argv[1], sys.argv[2]
gas = sys.argv[3] if len(sys.argv) > 3 else "300"
root = os.path.join(os.path.dirname(__file__), crate)

# 1) no_std header in src/lib.rs
lib = os.path.join(root, "src", "lib.rs")
src = open(lib).read()
if "no_std" not in src:
    header = "#![cfg_attr(not(test), no_std)]\n#![cfg_attr(not(test), no_main)]\n"
    # insert `extern crate alloc;` before the first `use ` line (after the //! block)
    lines = src.splitlines(keepends=True)
    out, inserted = [], False
    for ln in lines:
        if not inserted and ln.lstrip().startswith("use "):
            out.append("extern crate alloc;\n\n")
            inserted = True
        out.append(ln)
    if not inserted:
        out.append("\nextern crate alloc;\n")
    open(lib, "w").write(header + "".join(out))
    print(f"  {crate}: added no_std header")

# 2) src/bin/build_contract.rs
os.makedirs(os.path.join(root, "src", "bin"), exist_ok=True)
open(os.path.join(root, "src", "bin", "build_contract.rs"), "w").write(
    '#![doc = "Binary for building wasm files from odra contracts."]\n'
    "#![no_std]\n"
    '#![cfg_attr(target_arch = "wasm32", no_main)]\n'
    "#![allow(unused_imports, clippy::single_component_path_imports)]\n"
    f"use {crate};\n\n"
    '#[cfg(not(target_arch = "wasm32"))]\n'
    "fn main() {}\n"
)

# 3) bin/livenet.rs
os.makedirs(os.path.join(root, "bin"), exist_ok=True)
open(os.path.join(root, "bin", "livenet.rs"), "w").write(
    f"//! Livenet deployer for {struct} — deploys to Casper Testnet via Odra 2.x.\n"
    f"use {crate}::{struct};\n"
    "use odra::host::{Deployer, NoArgs};\n"
    "use odra::prelude::Addressable;\n"
    "use odra_casper_livenet_env::env;\n\n"
    "fn main() {\n"
    "    let env = env();\n"
    f"    env.set_gas({gas}_000_000_000u64);\n"
    f"    let contract = {struct}::deploy(&env, NoArgs);\n"
    f'    println!("CRED402_DEPLOYED {crate} {{}}", contract.address().to_string());\n'
    "}\n"
)

# 4) Odra.toml
open(os.path.join(root, "Odra.toml"), "w").write(f'[[contracts]]\nfqn = "{struct}"\n')

# 5) build.rs
open(os.path.join(root, "build.rs"), "w").write("fn main() {\n    odra_build::build();\n}\n")

# 6) Cargo.toml
open(os.path.join(root, "Cargo.toml"), "w").write(
    f"""[package]
name = "{crate}"
version = "0.1.0"
edition = "2021"

[dependencies]
odra = {{ workspace = true }}
odra-casper-livenet-env = {{ version = "2", optional = true }}

[dev-dependencies]
odra-test = {{ workspace = true }}

[lib]
crate-type = ["cdylib", "rlib"]

[features]
default = []
livenet = ["dep:odra-casper-livenet-env"]

[[bin]]
name = "{crate}_build_contract"
path = "src/bin/build_contract.rs"
test = false

[[bin]]
name = "livenet"
path = "bin/livenet.rs"
required-features = ["livenet"]

[build-dependencies]
odra-build = "2"
"""
)
print(f"  {crate}: scaffolded ({struct})")
