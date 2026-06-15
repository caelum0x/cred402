# Cred402 EVM Satellite

> **Casper-rooted, chain-executed.** EVM can *execute* credit, but Casper *approves* credit.

This Foundry project is the EVM (e.g. Base `eip155:8453`) satellite of the Cred402
omnichain agent-credit protocol. Casper remains the canonical root for identity,
reputation, x402 receipt history, RWA evidence, credit policy, disputes, and global
exposure. The EVM side hosts liquidity and execution, and anchors everything back to
Casper through events that relayers observe.

## Responsibilities

```text
accept local x402 settlement          -> Cred402ReceiptInbox
emit receipt events                   -> Cred402ReceiptOutbox (ReceiptCreated)
host local RWA wrappers               -> Cred402RWAMirror (UAID-keyed)
host local credit vaults              -> Cred402CreditVault (ERC20 / USDC)
verify Casper-issued credit notes     -> Cred402CreditNoteVerifier (ed25519 CAN)
report credit draws back to Casper    -> Cred402ExposureReporter (ExposureChanged)
mirror dispute status                 -> Cred402DisputeMirror
```

## The EVM credit rule

A satellite credit vault lends **only** against a valid Casper-policy-signed
Credit Authorization Note (CAN), and **never** beyond `CAN.max_draw`.

```text
EVM vault asks:
  "Does this agent have a valid Casper credit authorization?"

Casper answers (inside the CAN):
  "Yes, up to max_draw, until expires_at, under risk_policy_version Z,
   for target_chain T and target_pool P, single-use under nonce N."
```

`Cred402CreditVault.draw(note, amount)` enforces, in order:

1. The vault is not paused (`Cred402EmergencyPause`).
2. The note is verified by `Cred402CreditNoteVerifier`:
   - `type == "Cred402CreditAuthorizationNote"`, `version == "1"`
   - `target_chain == CHAIN_ID_CAIP2` configured on the verifier
   - `target_pool == address(vault)`
   - `block.timestamp <= expires_at`
   - `nonce` has not been consumed before (replay protection)
   - the Casper policy **ed25519** signature over the CAN canonical bytes is valid,
     checked through the `ICasperSigVerifier` precompile/oracle interface.
3. `amount <= note.max_draw`.
4. The note is consumed **once** (one note = one credit line opening / draw).
5. Per-agent debt is incremented and USDC is transferred to the borrower.

`repay(agentId, amount)` reduces per-agent debt and pulls USDC back into the pool.
Both `draw` and `repay` emit events that `Cred402ExposureReporter` relays back to the
Casper `GlobalExposureManager`, which adjusts the agent's global exposure and prevents
the multi-chain over-borrow failure mode:

```text
Agent borrows 500 on Casper, 500 on EVM, 500 on Solana, 500 on Cosmos, then defaults.
```

## Money units

All amounts are integer smallest-units. USDC has 6 decimals; `1 USD micro-unit == 1
USDC base unit`. `max_draw`, `amount`, and exposure values are unsigned integers in
those base units. CSPR motes (9dp) live on the Casper side only.

## Standards mirrored

The Solidity `CreditAuthorizationNote` struct mirrors the canonical TypeScript
standard at `crosschain/standards/credit_notes.ts` field-for-field. The canonical
signing bytes are the CAN object **without** the `casper_policy_signature` field,
serialized as canonical JSON (stable key order). Off-chain relayers produce those
exact bytes; on-chain we verify the ed25519 signature over the supplied
`canonicalSigningBytes` and additionally bind them to the struct fields by
re-deriving and comparing the structural commitment.

## Contract suite

| Contract | Role |
|----------|------|
| `Cred402SatelliteRegistry` | Register satellite agents mirrored from Casper (CAID). |
| `Cred402AddressBindingMirror` | Store Casper-verified address bindings; `BindingMirrored`. |
| `Cred402ReceiptOutbox` | Emit `ReceiptCreated`; store receipt commitments for relayers. |
| `Cred402ReceiptInbox` | Accept local x402 settlement and forward to the outbox. |
| `Cred402RWAMirror` | UAID-keyed RWA wrapper mirror. |
| `Cred402EvidenceOutbox` | Emit `EvidenceAttested` for RWA evidence relayed to Casper. |
| `Cred402CreditNoteVerifier` | Verify CAN ed25519 signature + expiry/target/nonce replay. |
| `Cred402CreditVault` | USDC credit vault: deposit/withdraw/draw/repay; per-agent debt. |
| `Cred402ExposureReporter` | Emit `ExposureChanged` relayed to Casper GlobalExposureManager. |
| `Cred402DisputeMirror` | Mirror Casper DisputeCourt status onto EVM. |
| `Cred402EmergencyPause` | Ownable pause guard used by the vault. |

## Layout

```text
contracts/evm/
  foundry.toml
  src/
    interfaces/ICasperSigVerifier.sol
    Cred402SatelliteRegistry.sol
    Cred402AddressBindingMirror.sol
    Cred402ReceiptOutbox.sol
    Cred402ReceiptInbox.sol
    Cred402RWAMirror.sol
    Cred402EvidenceOutbox.sol
    Cred402CreditNoteVerifier.sol
    Cred402CreditVault.sol
    Cred402ExposureReporter.sol
    Cred402DisputeMirror.sol
    Cred402EmergencyPause.sol
  script/Deploy.s.sol
  test/Cred402CreditVault.t.sol
```

## The `ICasperSigVerifier` precompile/oracle

EVM chains have no native ed25519 precompile at a standard address, so Cred402 routes
Casper ed25519 verification through `ICasperSigVerifier` (see
`src/interfaces/ICasperSigVerifier.sol`). It mirrors a precompile-style call:

```solidity
function verifyEd25519(bytes32 publicKey, bytes calldata message, bytes calldata signature)
    external view returns (bool);
```

Deployments may point this at:

- A real ed25519 verification precompile where the chain provides one
  (documented canonical address `0x0000000000000000000000000000000000000402`), or
- A trusted oracle/adapter contract that wraps such verification.

The vault and verifier never trust raw input: they require the configured verifier to
return `true` before any credit is opened.

## Build & test

```bash
cd contracts/evm
forge build
forge test -vvv
```

The test suite (`test/Cred402CreditVault.t.sol`) uses a mock `ICasperSigVerifier` and
proves the core invariants:

- lend only with a valid, target-matching, unexpired note;
- reject draws above `max_draw`;
- reject a replayed (already consumed) note;
- the deposit -> draw -> repay flow keeps per-agent debt and pool liquidity correct.
