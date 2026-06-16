# Cred402 — Solana / SVM Satellite

> **Casper-rooted, chain-executed.** Casper is the canonical trust, identity,
> reputation, receipt, and credit-policy root for the autonomous agent economy.
> Solana is an **execution and liquidity satellite** that anchors back to Casper.

This Anchor workspace implements the Solana satellite from Cred402's
"Casper-rooted, chain-executed" multichain design (see [`docs/p10.md`](../../docs/p10.md)).
The SVM family is tuned for
**high-speed agent payments and real-time data markets**, so these programs
optimize for throughput and low latency, not for being a second source of truth.

## Solana responsibilities

| Responsibility | Program |
| --- | --- |
| **Fast paid API settlement** — agents pay-per-call over x402 and settle in sub-second finality | `cred402_receipt_outbox` |
| **High-volume agent receipt generation** — every x402 payment becomes a Universal Receipt Envelope (URE) commitment anchored back to Casper | `cred402_receipt_outbox` |
| **Low-latency evidence attestations** — RWA evidence (EAE) mirrored at speed for real-time data markets | `cred402_evidence_mirror` |
| **Local vaults with conservative caps** — lend only against a valid, unexpired, Casper-policy-signed Credit Authorization Note (CAN) | `cred402_credit_vault` |
| **Address binding & satellite identity registry** — bind Solana addresses to Casper-rooted CAIDs | `cred402_satellite_registry` |
| **Report draws/repayments back to Casper** — feed the Casper `GlobalExposureManager` to prevent multi-chain over-borrow | `cred402_exposure_reporter` |

## The iron rule of satellite credit

> A satellite pool lends **ONLY** against a valid, unexpired, target-matching,
> Casper-policy-signed CAN, and **never beyond `CAN.max_draw`**.
>
> **Solana executes credit. Casper approves credit.**

`cred402_credit_vault::draw` enforces, in order:

1. The CAN `target_chain` matches this cluster's configured chain id (`solana:<genesis_hash>`).
2. The CAN `target_pool` matches this vault PDA.
3. `now <= CAN.expires_at` (not expired).
4. The vault's accepted Casper policy public key produced `CAN.casper_policy_signature`
   over the canonical CAN signing payload — verified through the native **Ed25519
   program** via instruction-sysvar introspection (the only sound way to check an
   ed25519 signature inside an SVM program).
5. `existing_debt + amount <= CAN.max_draw` and `<= vault.max_draw_cap` (the
   conservative local cap) and `<= vault.available_liquidity`.

Draws and repayments emit events consumed by the
`solana-to-casper-relayer`, which reports them to the Casper
`GlobalExposureManager` so an agent cannot over-borrow across chains.

## Canonical standards mirrored

All envelopes mirror the TypeScript standards in
[`crosschain/standards`](../../crosschain/standards) **exactly**:

- **CAID** — `cred402:casper:<agent_id>`
- **UAID** — `uaid:<asset_type>:<blake2b256(...)>`
- **ABE** — Address Binding Envelope (dual-signed)
- **URE** — Universal Receipt Envelope, `receipt_id = blake2b256(canonical_json(URE))`
- **CAN** — Credit Authorization Note, Casper-policy-signed (ed25519)
- **EAE** — Evidence Attestation Envelope, agent-Casper-key-signed

### Money units

All amounts are **integer smallest-units** stored as `u64`:

- USDC — 6 decimals (1 USD micro-unit == 1 USDC base unit)
- CSPR — 9 decimals (motes)

No floats, ever.

### Hashes

`receipt_id`, `request_hash`, `result_hash`, `payment_proof_hash`,
`evidence_hash`, etc. are **BLAKE2b-256** digests computed off-chain by the
standards library and submitted as 32 raw bytes. On-chain programs store and
index these commitments; they never recompute BLAKE2b on-chain (the off-chain
canonicalization in `crosschain/standards` is authoritative).

## Programs

```text
contracts/solana/
  Anchor.toml
  Cargo.toml                 # workspace
  programs/
    cred402_satellite_registry/   # bind Solana addresses to Casper CAIDs
    cred402_receipt_outbox/       # record URE commitments, emit ReceiptCreated
    cred402_evidence_mirror/      # mirror EAE attestations at low latency
    cred402_credit_vault/         # CAN-gated draws + repayments, conservative caps
    cred402_exposure_reporter/    # emit draw/repay deltas for the Casper relayer
```

## Build & test

```bash
anchor build
anchor test
```

Program ids are placeholders in `Anchor.toml` / `declare_id!`; replace them with
`anchor keys sync` output before any devnet/mainnet deploy.
