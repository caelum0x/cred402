# Cred402 Flare Satellite — Interoperable Asset Products

> **Casper approves credit; Flare executes it in XRP liquidity; FTSO prices it.**

This Foundry project is the **Flare** satellite of the Cred402 omnichain agent-credit
protocol, built for the Flare Summer Signal hackathon (Interoperable Asset Products
bounty). It lets an agent that has earned x402 revenue on any chain borrow working
capital in **FXRP** — XRP bridged 1:1 into a first-class ERC-20 FAsset on Flare —
without ever giving up the Casper-rooted, global-exposure-checked credit guarantees.

Three enshrined Flare capabilities make this concrete:

- **FAssets (FXRP)** — the interoperable settlement + collateral asset. XRP liquidity,
  usable inside EVM smart contracts.
- **FTSO (Flare Time Series Oracle)** — the canonical collateral oracle. Every draw is
  priced in USD from the live XRP/USD feed, so the shared global-exposure cap is
  enforced in one denominator across every satellite (Casper, EVM, Flare…).
- **FlareContractRegistry** — resolves FTSOv2 (and every other enshrined contract) by
  name at runtime, so no oracle address is ever hardcoded. Same address on every
  Flare-family network: `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`.

## The Flare credit rule

A satellite credit vault lends **only** against a valid, Casper-policy-signed
Credit Authorization Note (CAN), and **never** beyond `CAN.max_draw`.

```text
Flare vault asks:
  "Does this agent have a valid Casper credit authorization for FXRP on THIS pool?"

Casper answers (inside the CAN):
  "Yes, up to max_draw, until expires_at, under risk_policy_version Z,
   for target_chain eip155:114 and target_pool P, single-use under nonce N."
```

`Cred402FlareCreditVault.executeDraw(note, canonicalSigningBytes, commitment, signature,
agent, amount)` enforces, in order:

1. `amount > 0` and `agent != 0`.
2. The CAN verifies and its nonce is consumed exactly once:
   - `type == "Cred402CreditAuthorizationNote"`, `version == "1"`
   - `asset == "FXRP"`
   - `targetChain == "eip155:114"` (derived from `block.chainid` at deploy time)
   - `targetPool == address(this)`
   - `block.timestamp <= expiresAt`
   - `nonce` not previously consumed (replay protection)
   - the struct is bound to the signed bytes via the structural `commitment`
   - the Casper policy **ed25519** signature over the canonical bytes is valid, checked
     through the `ICasperSigVerifier` precompile/oracle.
3. `amount <= note.max_draw`.
4. The vault holds enough free FXRP liquidity.
5. FXRP is sent to `agent`, per-agent debt is incremented, the draw is priced in USD
   from the live FTSO XRP/USD feed, and `CreditDrawn(agent, amount, usdValue, noteId, …)`
   is emitted.

`executeRepay(agent, amount)` reduces per-agent debt and pulls FXRP back into the pool,
emitting `CreditRepaid`. Both events are relayed back to the Casper `GlobalExposureManager`
so the agent's multi-chain debt reconciles and the classic over-borrow failure mode
(borrow the max on every chain, then default) is prevented.

This Solidity contract mirrors its TypeScript twin,
`packages/chain-adapters/src/adapters/flare/FlareSatelliteVault.ts`, rule-for-rule.

## How FTSO pricing + CAN verification + KeeperHub fit together

```text
                 issues + ed25519-signs a CAN
   Casper root ─────────────────────────────────► KeeperHub (off-chain executor)
   (policy key,                                     observes CANs, builds the exact
    global exposure)                                canonical signing bytes + signature
        ▲                                                     │ submits executeDraw(...)
        │ relays CreditDrawn / CreditRepaid                   ▼
        │                                    Cred402FlareCreditVault (Coston2 / Flare)
        └────────────────────────────────────  verify CAN ── price via FTSO ── send FXRP
                                                    │                 │
                                          ICasperSigVerifier   FtsoV2.getFeedById(XRP/USD)
                                          (ed25519)            resolved from the registry
```

- **CAN verification** is the trust gate: no FXRP leaves the vault unless the Casper
  policy key signed a note for this exact pool, chain, asset, and ceiling, and only once
  per nonce.
- **FTSO pricing** is the accounting gate: the draw's USD value (6 dp, USDC-comparable)
  is read live from `FtsoV2.getFeedById(XRP_USD_FEED_ID)`, where
  `XRP_USD_FEED_ID = 0x015852502f55534400000000000000000000000000`
  (category byte `0x01` + ASCII `"XRP/USD"`, right-padded to 21 bytes). FtsoV2 is
  resolved from the FlareContractRegistry, never hardcoded.
- **KeeperHub** is the off-chain execution / reliability layer. It never has custody and
  never has discretion: it can only submit draws that a valid CAN already authorizes, it
  retries on transient RPC failure, and it relays the resulting events back to Casper.

## FXRP + USD units

FXRP mirrors XRP at 6 decimals, so all `amount`, `max_draw`, and liquidity figures are
integer smallest-units (6 dp). USD values are 6-dp integers (USDC-style micro-units), so
`usdValue` compares 1:1 against USDC exposure on other satellites. Liquidity is
provisioned by transferring FXRP directly into the vault; drawn principal leaves the
vault, so its FXRP balance is exactly the free pool (`availableLiquidity()`).

## Build

```bash
cd contracts/flare
forge build
```

The project vendors no external libraries: `IERC20`, `ICasperSigVerifier`, `IFtsoV2`, and
`IFlareContractRegistry` are declared locally, matching the EVM satellite's
dependency-free convention. (`forge-std` — used only by the deploy script — is the single
Foundry dependency; install it with `forge install foundry-rs/forge-std` if it is not
already present under `lib/`.)

## Get testnet funds (Coston2)

You need **C2FLR** for gas and **FXRP** for the pool. Both are available from the faucet:

- Coston2 faucet: <https://faucet.flare.network/coston2>

Fund the deployer address with C2FLR, then acquire FXRP (via the faucet / FAssets mint
flow) and transfer some into the deployed vault to provision lending liquidity.

## Deploy to Coston2

Set the environment variables and run the script against the `coston2` RPC endpoint
(already wired in `foundry.toml`):

```bash
export PRIVATE_KEY=0x...                 # deployer, funded with C2FLR
export FXRP_ADDRESS=0x...                # FXRP FAsset ERC20 (6 dp)
export CASPER_POLICY_KEY_HASH=0x...      # 32-byte Casper policy ed25519 public key

# Optional overrides (sensible defaults are used otherwise):
# export CASPER_SIG_VERIFIER=0x...       # default: canonical ed25519 precompile 0x…0402
# export FTSOV2_OR_REGISTRY=0x...        # default: FlareContractRegistry 0xaD67…6019

forge script script/DeployCoston2.s.sol:DeployCoston2 \
  --rpc-url coston2 \
  --broadcast
```

The script logs the deployed vault address, the resolved chain id (114), and the derived
`chainCaip2` (`eip155:114`). The same script also targets Flare mainnet — swap
`--rpc-url coston2` for `--rpc-url flare` (chain id 14).

## Verify (Blockscout)

Coston2's explorer is Blockscout, not Etherscan:

```bash
forge verify-contract <deployed-address> Cred402FlareCreditVault \
  --verifier blockscout \
  --verifier-url https://coston2-explorer.flare.network/api
```

## Explorer

- Coston2 explorer: <https://coston2-explorer.flare.network>
- FlareContractRegistry (all Flare-family chains): `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`

## Layout

```text
contracts/flare/
  foundry.toml
  README.md
  src/
    interfaces/
      ICasperSigVerifier.sol      # ed25519 policy-signature verification (mirrors EVM)
      IFtsoV2.sol                 # FTSOv2 price oracle (getFeedById / getFeedsById)
      IFlareContractRegistry.sol  # resolve enshrined contracts by name
    Cred402FlareCreditVault.sol   # FXRP credit vault: executeDraw / executeRepay + views
  script/
    DeployCoston2.s.sol           # deploy to Coston2 (chain id 114)
```

## Contract surface

| Function | Role |
|----------|------|
| `executeDraw(note, canonicalSigningBytes, commitment, signature, agent, amount)` | Verify a CAN, price via FTSO, lend FXRP, record debt, emit `CreditDrawn`. |
| `executeRepay(agent, amount)` | Reduce debt, pull FXRP back, emit `CreditRepaid`. |
| `checkNote(...)` | Pure view CAN verification (no nonce consumption). |
| `structuralCommitment(note)` | keccak commitment binding the CAN struct to its signed bytes. |
| `debtOf(agent)` | Outstanding FXRP debt for an agent. |
| `availableLiquidity()` | Free FXRP in the pool (`fxrp.balanceOf(vault)`). |
| `consumedNote(noteId)` | Whether a CAN nonce has already drawn. |
| `quoteUsd(amount)` / `latestXrpUsd()` | Live FTSO USD pricing / raw feed read. |
