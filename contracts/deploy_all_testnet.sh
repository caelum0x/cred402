#!/usr/bin/env bash
# Deploy Cred402 Odra contracts to Casper Testnet via the odra 2.x livenet env.
# For each "crate:Struct", scaffold (idempotent), build the Casper-2.0 wasm with
# the per-contract odra_module cfg, then deploy and capture the contract address.
set -uo pipefail
cd "$(dirname "$0")"

export ODRA_CASPER_LIVENET_SECRET_KEY_PATH="$(cd .. && pwd)/.secrets/testnet_deployer.pem"
export ODRA_CASPER_LIVENET_NODE_ADDRESS="https://node.testnet.casper.network/rpc"
export ODRA_CASPER_LIVENET_EVENTS_URL="https://node.testnet.casper.network/events"
export ODRA_CASPER_LIVENET_CHAIN_NAME="casper-test"

OUT="../deploys.addresses.txt"

for pair in "$@"; do
  crate=$(echo "$pair" | cut -d: -f1); struct=$(echo "$pair" | cut -d: -f2); gas=$(echo "$pair" | cut -d: -f3)
  gas="${gas:-300}"
  echo "──────── $crate ($struct) gas=$gas ────────"
  python3 scaffold_livenet.py "$crate" "$struct" "$gas" >/dev/null 2>&1
  RUSTFLAGS="--cfg odra_module=\"$struct\"" cargo build --release --target wasm32-unknown-unknown \
    --bin "${crate}_build_contract" >/tmp/wasm_$crate.log 2>&1
  if [ ! -f "target/wasm32-unknown-unknown/release/${crate}_build_contract.wasm" ]; then
    echo "  ✗ wasm build failed"; tail -3 /tmp/wasm_$crate.log; continue
  fi
  mkdir -p "$crate/wasm"
  cp "target/wasm32-unknown-unknown/release/${crate}_build_contract.wasm" "$crate/wasm/$struct.wasm"
  addr=$( cd "$crate" && cargo run --release --bin livenet --features livenet 2>&1 | grep "CRED402_DEPLOYED" | awk '{print $3}' )
  if [ -n "$addr" ]; then
    echo "  ✓ $struct -> $addr"
    echo "$crate $struct $addr" >> "$OUT"
  else
    echo "  ✗ deploy failed (see output)"
    ( cd "$crate" && cargo run --release --bin livenet --features livenet 2>&1 | grep -iE "failed|error|LINK" | grep -ivE "warning|note|help" | tail -3 )
  fi
done
echo ""; echo "=== deployed addresses ($OUT) ==="; cat "$OUT" 2>/dev/null
