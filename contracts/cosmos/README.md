# Cred402 Cosmos Satellites (CosmWasm)

> **Casper-rooted, chain-executed.** Casper is the canonical trust, identity,
> reputation, x402 receipt history, RWA evidence, credit-policy, dispute, and
> global-exposure layer. The Cosmos contracts in this directory are **satellites**:
> they host liquidity, assets, and local execution, but every credit decision is
> anchored back to a Casper-signed authorization.

Cosmos is the natural home for **appchain-style RWA markets**. These CosmWasm
contracts give Cred402 a satellite footprint across the IBC ecosystem.

## Responsibilities

This satellite family targets:

- **RWA-specific appchains** — sovereign chains dedicated to a single real-world
  asset class (private credit, invoices, carbon, real estate) where the canonical
  evidence graph still lives on Casper but the local market trades on Cosmos.
- **IBC-style asset environments** — assets that move over IBC are mirrored here
  with their Casper-rooted `UAID`, so credit and receipts stay consistent as
  assets hop between zones.
- **Regional RWA marketplaces** — jurisdiction-scoped marketplaces (e.g. an
  appchain serving one regulatory region) that need local settlement but global
  reputation.
- **Local agent service markets** — agent-to-agent paid service markets settling
  x402 payments natively on a Cosmos chain.

## Contracts

| Contract | Purpose |
| --- | --- |
| `cw-cred402-satellite-registry` | Mirrors Casper-rooted agent identity (`CAID`) and Address-Binding (`ABE`) status onto this chain so local contracts can resolve `agent_id → cosmos address`. |
| `cw-cred402-receipt-outbox` | Accepts local x402 settlements, recomputes the Universal Receipt Envelope (`URE`) `receipt_id = blake2b256(canonical_json(URE))`, and emits an outbox event for the cosmos→casper relayer to anchor. |
| `cw-cred402-rwa-mirror` | Mirrors Casper RWA registry state: `UAID`, asset metadata, and the latest Casper-attested valuation / evidence digest for assets traded on this appchain. |
| `cw-cred402-credit-vault` | The execution surface for credit. Lends local liquidity **only** against a valid, unexpired, target-matching, Casper-policy-signed Credit Authorization Note (`CAN`), never beyond `CAN.max_draw`, with nonce replay protection. Reports draws/repayments to the exposure reporter. |
| `cw-cred402-exposure-reporter` | Aggregates per-agent local exposure (draws minus repayments) and emits outbox events the relayer forwards to Casper's `GlobalExposureManager`, preventing multi-chain over-borrow. |

## The credit rule (non-negotiable)

> **EVM/Cosmos executes credit. Casper approves credit.**

A satellite credit vault asks: *"Does this agent have a valid Casper credit
authorization?"* Casper answers via a **Credit Authorization Note (CAN)**:
*"Yes, up to X, until timestamp Y, under policy version Z, for this exact
target chain and pool."*

`cw-cred402-credit-vault` enforces every clause of that answer on-chain before a
single token leaves the pool:

1. **Type** must be `Cred402CreditAuthorizationNote`.
2. **Signature** — ed25519 over the canonical JSON of the CAN (all fields except
   `casper_policy_signature`, keys sorted) must verify against the Casper policy
   public key configured at instantiation. This mirrors the TypeScript
   `noteSigningPayload` / `verifyCreditAuthorizationNote` semantics exactly.
3. **Expiry** — `env.block.time <= expires_at`.
4. **Target** — `target_chain` and `target_pool` must match this vault's
   configured identity.
5. **Cap** — cumulative draws for the note must never exceed `max_draw`.
6. **Replay** — the CAN `nonce` is recorded; a nonce can authorize a credit line
   once.

## Money units

All amounts are integer smallest-units, kept as strings on the wire (matching the
URE/CAN envelopes) and as `Uint128` on-chain:

- USDC: 6 decimals (1 USD micro-unit == 1 USDC base unit).
- CSPR: 9 decimals (motes).

No floating point is ever used for money.

## Canonical-JSON compatibility

The receipt-outbox and credit-vault recompute Casper-compatible digests/signatures
on-chain. They use a small canonical JSON serializer (`canonical_json` in each
crate's `state.rs`) that reproduces the TypeScript `stableStringify`: object keys
are emitted in sorted order, strings are JSON-escaped, numbers are emitted as
integers, and there is no insignificant whitespace. blake2b-256 digests are
rendered as `0x`-prefixed lowercase hex, identical to `lib/core/hash.ts`.

## Build

Each crate is an independent CosmWasm contract targeting `cosmwasm-std` 2.x.

```bash
# from any contract directory
cargo build --target wasm32-unknown-unknown --release
```

Optimized wasm builds use the standard CosmWasm rust-optimizer workflow.
