# Cred402 smart contracts (Odra / Casper)

Five small, focused contracts written with [Odra](https://odra.dev), the Rust smart
contract framework for Casper.

| Crate                     | Responsibility |
| ------------------------- | -------------- |
| `agent_registry`          | Agent identity, stake, reputation, credit score; slashing. |
| `x402_receipt_registry`   | Commitments for x402 payment receipts (the cash-flow proofs). |
| `rwa_evidence_registry`   | Hashed RWA evidence, linked to the paying receipt. |
| `agent_credit_pool`       | The DeFi pool: deposit / open line / draw / repay / liquidate. |
| `risk_policy_manager`     | Upgradable underwriting policy (v1 → v2). |
| `dispute_court`           | Challenges, dispute lifecycle, on-chain verdicts (p2 §6.9). |
| `slashing_vault`          | Slashed-stake custody + distribution (p2 §6.10). |
| `governance`              | Protocol parameters, fees, emergency pause (p2 §6.11). |

> The TypeScript ledger additionally mirrors `RWAAssetRegistry`, `ReputationEngine`
> and `AgentPassport` (p2 §6.2–6.6); those follow the same Odra patterns and can be
> promoted to crates identically.

Each contract mirrors a TypeScript module under `../lib/ledger/contracts/` with the
same state, methods and events — so the off-chain agent runtime and dashboard work
against either the live contracts or the in-memory simulation unchanged.

## Build

```bash
# install the Odra toolchain once
cargo install cargo-odra

# from this directory
cargo odra build          # produces wasm under target/.../release/*.wasm
cargo odra test           # runs Odra's in-memory + casper VM tests
```

> Building requires the `wasm32-unknown-unknown` target and the Odra dependency
> graph from crates.io. If you only want to run the full agent economy, you do not
> need to build these — `npm run demo` uses the faithful simulation in `../lib/ledger`.

## Deploy to Testnet

See `../scripts/deploy_testnet.ts` for the deploy plan. With a funded key:

```bash
export CRED402_NODE=https://rpc.testnet.casperlabs.io
export CRED402_SECRET_KEY=/path/to/secret_key.pem
npm run deploy:testnet     # prints casper-client commands + writes deploys.testnet.json
```

Then wire the deployed contract hashes into the API by replacing the simulation
calls in `../lib/ledger` with `casper-js-sdk` contract calls (the method surface is
identical).

## Design notes

- All value is `U512` motes (1 CSPR = 1e9 motes).
- Privileged methods (`slash`, `update_reputation`, `open_credit_line`, `freeze`,
  `liquidate`, `upgrade`) are admin-gated to the deploying protocol account.
- `risk_policy_manager` keeps the policy version in storage; `upgrade(version)`
  hot-swaps the active formula — the upgradable-contract story Casper highlights for
  autonomous systems.
- Events mirror the streaming-events the WatchdogAgent and dashboard consume.
