# Cred402 × Flare — Interoperable FXRP Credit + Confidential Scoring

> **Casper approves credit; Flare executes it in XRP liquidity; FTSO prices it; the
> FDC proves the payment; Confidential Compute keeps the borrower's cash flow private.**

This is Cred402's **Flare** satellite, built for both Flare Summer Signal bounties:

- **Bounty 1 — Interoperable Asset Products.** The satellite lends the FAsset **FXRP**
  (XRP bridged 1:1 into an EVM ERC-20) against a Casper-signed Credit Authorization Note
  (CAN), priced in USD by the **live FTSO XRP/USD feed**, with the **FDC** attesting the
  cross-chain x402 payment that makes the agent creditworthy.
- **Bounty 2 — Confidential Compute.** The probability-of-default model runs inside
  **Flare Confidential Compute** (a TEE). The agent's raw cash-flow features never leave
  the enclave; only an attested score + input/model commitments are published.

Flare is EVM, so the FXRP draw is submitted on-chain through **KeeperHub** — one execution
seam serves both hackathons (see [keeperhub_integration.md](keeperhub_integration.md)).

## Coston2 facts

| | |
|---|---|
| Network | Flare Testnet **Coston2** |
| Chain id | **114** (`eip155:114`) |
| RPC | `https://coston2-api.flare.network/ext/C/rpc` |
| Explorer (Blockscout) | `https://coston2-explorer.flare.network` |
| Faucet (C2FLR + FXRP) | `https://faucet.flare.network/coston2` |
| Native gas token | `C2FLR` |
| FlareContractRegistry | `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` (same on Flare / Songbird / Coston / Coston2) |

Mainnet is chain id **14** (`https://flare-api.flare.network/ext/C/rpc`,
`https://flare-explorer.flare.network`). All networks are defined in
`packages/chain-adapters/src/adapters/flare/networks.ts`.

---

## Bounty 1 — Interoperable Asset Products

### The interoperable credit loop

```text
  Agent earns x402 revenue on any chain
        │
        ▼
  FDC attests the payment really settled          (fdc.ts — Payment attestation)
        │
        ▼
  Casper root issues a USD-limited, ed25519-signed CAN   (global-exposure checked)
        │
        ▼
  FlareSatelliteVault verifies the CAN, lends FXRP        (FlareSatelliteVault.ts)
        │  priced in USD from the live FTSO XRP/USD feed   (ftso.ts + fassets.ts)
        ▼
  KeeperHub executes executeDraw(...) on-chain            (the last mile)
```

The rule the vault enforces: **lend FXRP only against a valid, Casper-policy-signed CAN,
never beyond `CAN.max_draw`, priced in one USD denominator so the shared global-exposure
cap holds across every satellite.**

### FTSO — the collateral oracle (`ftso.ts`)

FTSO (Flare Time Series Oracle) is Flare's enshrined, decentralized price oracle
(block-latency feeds secured by ~100 independent providers). Cred402 uses it as the
**canonical** collateral-pricing oracle: no third-party price API, no mock.

- **Real path (`FLARE_RPC_URL` set):** `FtsoV2.getFeedById(bytes21)` over JSON-RPC
  `eth_call`. FtsoV2 is resolved at runtime from the FlareContractRegistry
  (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`) unless `FLARE_FTSOV2_ADDRESS` pins it —
  no oracle address is ever hardcoded.
- **Feed id encoding:** category byte `0x01` (crypto) + ASCII of the feed name,
  right-padded to 21 bytes. `"XRP/USD"` →
  `0x015852502f55534400000000000000000000000000`.
- **Sim path (no RPC):** deterministic reference prices (e.g. `XRP/USD = $0.52`), same
  return shape. A transient RPC failure degrades to sim rather than breaking underwriting.

### FAssets / FXRP (`fassets.ts`)

FAssets brings non-smart-contract assets (starting with XRP) onto Flare as first-class
ERC-20s. FXRP is XRP bridged 1:1, minted against over-collateralized agents, redeemable
back to the XRP Ledger.

- FXRP mirrors XRP at **6 decimals** — every `amount`, `max_draw`, and liquidity figure is
  an integer smallest-unit.
- `fxrpValueUsd(amount, ftso)` values an FXRP amount as a 6-dp USD integer (USDC-style
  micro-units) from the live FTSO feed, so FXRP exposure compares 1:1 against USDC exposure
  on other satellites.
- An `FxrpMint` links minted FXRP to the `fdc_attestation_id` that proves the underlying
  XRPL payment happened.

### FDC — cross-chain payment attestation (`fdc.ts`)

The FDC (Flare Data Connector) is Flare's enshrined oracle for *external* data and
cross-chain events. It attests a fact (a payment on the XRP Ledger, an EVM transaction,
address validity) and delivers a Merkle proof a Flare contract can verify on-chain.

For Cred402 it closes the interoperability loop: an agent earns an x402 payment on another
chain, the FDC attests it settled, and only then does the satellite treat the Universal
Receipt as trustworthy. **Casper roots identity + policy; the FDC roots the *fact* that
off-Flare value moved.**

- **Real path (`FLARE_FDC_VERIFIER_URL` set):** POST a typed `Payment` attestation request
  to `<verifier>/Payment/prepareRequest` (e.g.
  `https://fdc-verifiers-testnet.flare.network/verifier/xrp`), optionally with
  `FLARE_FDC_API_KEY`; `status: "VALID"` + an `abiEncodedRequest` yields a verified
  attestation. A relayer submits it to the FdcHub and, after the voting round finalizes,
  the Merkle proof is retrieved from the DA layer.
- **Sim path:** a deterministic attestation id + verified envelope. `FlareAdapter.submitReceipt()`
  attests every x402 receipt and records `fdc:<source>:<verified|unverified>`.

### The on-chain vault (`contracts/flare/`)

`Cred402FlareCreditVault.sol` is the Solidity twin of `FlareSatelliteVault.ts`,
rule-for-rule. Its `executeDraw(note, canonicalSigningBytes, commitment, signature, agent,
amount)` enforces, in order:

1. `amount > 0`, `agent != 0`.
2. CAN verifies + nonce consumed exactly once: `type == "Cred402CreditAuthorizationNote"`,
   `version == "1"`, `asset == "FXRP"`, `targetChain == "eip155:114"` (from
   `block.chainid`), `targetPool == address(this)`, `block.timestamp <= expiresAt`, nonce
   unused, struct bound to the signed bytes via `commitment`, and the Casper policy
   **ed25519** signature valid via the `ICasperSigVerifier` precompile.
3. `amount <= note.max_draw`.
4. Vault holds enough free FXRP.
5. FXRP sent to `agent`, debt incremented, draw priced in USD from
   `FtsoV2.getFeedById(XRP_USD_FEED_ID)`, `CreditDrawn` emitted.

`executeRepay(agent, amount)` reduces debt and pulls FXRP back, emitting `CreditRepaid`.
Both events relay to the Casper `GlobalExposureManager` so multi-chain debt reconciles and
the classic over-borrow failure mode (borrow the max on every chain, then default) is
prevented. Contract surface: `checkNote`, `structuralCommitment`, `debtOf`,
`availableLiquidity`, `consumedNote`, `quoteUsd`, `latestXrpUsd`. See
[../contracts/flare/README.md](../contracts/flare/README.md).

### KeeperHub tie-in

Flare is EVM, so once the vault has decided and priced the draw, the actual on-chain
submission goes through KeeperHub as an `OnchainExecutor` (`FlareAdapter` constructor
option). The adapter builds the intent —
`function: "executeDraw(bytes32,address,uint256)"`, `chain_id: "114"` — and KeeperHub runs
the reliability envelope (simulate → smart gas w/ backoff → private routing → poll → audit).
One execution seam serves the interoperable-asset flow and the confidential-scoring flow
alike.

---

## Bounty 2 — Confidential Compute

### The privacy invariant (`lib/flare/confidential_score.ts`)

A credit bureau's most sensitive input is the borrower's raw cash-flow history — here, an
agent's private x402 revenue, stake, and dispute record. Publishing those on-chain to
justify a score would leak exactly what must stay private.

Flare Confidential Compute (Intel TDX-backed TEE) runs the probability-of-default model
inside a hardware enclave: **raw features enter the enclave, the model runs, and only an
attested score + cryptographic commitments leave.** Anyone can verify the score was
produced by the audited model over the committed inputs — *without seeing the inputs.*

The published `ConfidentialScoreAttestation` contains **no raw feature values** — that
invariant is the whole point:

```jsonc
{
  "type": "Cred402ConfidentialScoreAttestation",
  "version": "1",
  "agent_id": "seller-agent",
  "score": 82,                       // 0..100, public
  "pd": 0.18,                        // probability of default, public
  "risk_band": "low",
  "input_commitment": "0x…",         // blake2b of the private feature vector — no raw values
  "model_commitment": "0x…",         // blake2b of the model weights that ran
  "enclave": {
    "platform": "flare-confidential-compute",
    "measurement": "0x…",            // MRTD/MRENCLAVE-style code measurement
    "quote": "0x…",                  // remote-attestation quote binding measurement→result
    "verified": true
  },
  "produced_at": 1723370000
}
```

- **Real path (`FLARE_CC_ATTESTATION_URL` set):** the enclave's remote-attestation quote is
  fetched from the confidential-compute attestation service (`POST <url>/attest`).
- **Sim path (`sim-tee`):** a deterministic quote over the same measurement + commitments.
  The published envelope is identical either way.

`verifyConfidentialScore(attestation, features)` lets the **data owner** (and only them)
recompute `input_commitment` from the raw features and confirm the attested score scored
*those exact inputs*. Everyone else just trusts the enclave quote + commitments.

---

## How to run

```bash
# End-to-end, sim by default (no keys, no network):
npm run flare:credit
```

`scripts/flare_credit.ts` runs the full loop: earn verifiable x402 revenue → FDC attests →
Confidential Compute scores (raw features private) → Casper signs a USD-limited CAN → the
Flare vault lends 500 FXRP priced by FTSO → KeeperHub executes the draw → repay + reliability
rollup.

### Light up the real rails

```bash
export FLARE_RPC_URL=https://coston2-api.flare.network/ext/C/rpc   # real FTSO XRP/USD read
export FLARE_FDC_VERIFIER_URL=https://fdc-verifiers-testnet.flare.network/verifier/xrp
export FLARE_CC_ATTESTATION_URL=https://<your-cc-attestation-service>
export KEEPERHUB_API_KEY=kh_your_org_key                          # real on-chain execution
npm run flare:credit
```

| Var | Default | Meaning |
|---|---|---|
| `FLARE_NETWORK` | `coston2` | Network key / CAIP-2 / chain id. |
| `FLARE_RPC_URL` | *(unset → sim)* | Presence flips FTSO to a real `getFeedById` read. |
| `FLARE_FTSOV2_ADDRESS` | *(unset)* | Pin FtsoV2 instead of resolving via the registry. |
| `FLARE_FDC_VERIFIER_URL` | *(unset → sim)* | FDC verifier base; we append `/Payment/prepareRequest`. |
| `FLARE_FDC_API_KEY` | *(unset)* | Optional FDC verifier key (`X-API-KEY`). |
| `FLARE_CC_ATTESTATION_URL` | *(unset → sim-tee)* | Confidential Compute attestation service. |

### Deploy the vault to Coston2

Fund the deployer with **C2FLR** (gas) and acquire **FXRP** for the pool from the
faucet (`https://faucet.flare.network/coston2`), then:

```bash
cd contracts/flare
forge build
export PRIVATE_KEY=0x...                 # deployer, funded with C2FLR
export FXRP_ADDRESS=0x...                # FXRP FAsset ERC20 (6 dp)
export CASPER_POLICY_KEY_HASH=0x...      # 32-byte Casper policy ed25519 public key
forge script script/DeployCoston2.s.sol:DeployCoston2 --rpc-url coston2 --broadcast
```

FtsoV2 is **not** passed as an address — the vault resolves it from the
FlareContractRegistry at runtime (default `FTSOV2_OR_REGISTRY`). The script logs the vault
address, chain id (114), and derived `chainCaip2` (`eip155:114`). Verify on Blockscout with
`--verifier blockscout --verifier-url https://coston2-explorer.flare.network/api`. Full
details in [../contracts/flare/README.md](../contracts/flare/README.md).

### /v1 endpoints

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/flare` | Satellite status: network, FXRP pool + liquidity, FTSO-live + KeeperHub-live flags. |
| `GET` | `/v1/flare/price` | Live XRP/USD from FTSO (or the deterministic reference). |
| `POST` | `/v1/flare/draw` | Draw FXRP: `{ agent_id, amount_fxrp }` → CAN + FTSO price + KeeperHub execution. |
| `POST` | `/v1/flare/repay` | Repay FXRP debt. |
| `GET` | `/v1/agents/:id/confidential-score` | Attested confidential score (raw features stay private). |
| `GET` | `/v1/keeperhub/reliability` · `/v1/keeperhub/audit` | KeeperHub execution observability. |

### MCP tools

| Tool | Purpose |
|---|---|
| `cred402.flare_info` | Satellite status + FTSO/KeeperHub live flags. |
| `cred402.flare_xrp_price` | Live FTSO XRP/USD price. |
| `cred402.flare_draw_fxrp` | Draw FXRP against a Casper CAN, FTSO-priced, KeeperHub-executed. |
| `cred402.flare_repay_fxrp` | Repay FXRP credit through KeeperHub. |
| `cred402.confidential_score` | Score an agent inside Confidential Compute; raw features stay private. |
| `cred402.keeperhub_reliability` · `cred402.keeperhub_audit` | Execution reliability + audit trail. |

---

## What was newly built / integrated / ported

The Flare Summer Signal submission asks for this explicitly:

- **Newly built:**
  - `FlareAdapter.ts` — the Flare satellite chain adapter (x402 settlement, FDC attestation,
    credit draw/repay, KeeperHub seam).
  - `FlareSatelliteVault.ts` — CAN-gated FXRP credit vault, FTSO-priced, mirroring the
    Solidity contract rule-for-rule.
  - `ftso.ts`, `fdc.ts`, `fassets.ts`, `networks.ts` — FTSO price client, FDC attestation
    client, FXRP model, and Flare-family network constants.
  - `lib/flare/confidential_score.ts` — the Confidential Compute PD scorer + verifier.
  - `lib/flare/satellite.ts` — `FlareCreditSatellite`, the one place that wires a ledger to
    the satellite so MCP, REST, and scripts share identical behavior.
  - `contracts/flare/` — `Cred402FlareCreditVault.sol` + interfaces + `DeployCoston2.s.sol`.
- **Integrated (Flare's enshrined capabilities):** FTSO (`FtsoV2.getFeedById` via the
  FlareContractRegistry), FDC (`Payment` attestation), FAssets (FXRP as ERC-20 collateral),
  and Flare Confidential Compute (TEE remote attestation).
- **Ported / extended:** the existing cross-chain **CAN + global-exposure** model
  (`crosschain/standards/*`, the Casper root, `RiskEngineV2`) was extended to Flare as a new
  satellite — same USD denominator, same single-use signed notes, same exposure reconciliation.

## What's real vs sim

Following the repo's *real-behind-env + deterministic sim* convention — same return shapes
either way, so the demo and test suite run with zero keys:

| Capability | Real (env set) | Sim (default) |
|---|---|---|
| FTSO pricing | `FtsoV2.getFeedById` `eth_call` via `FLARE_RPC_URL`, FtsoV2 resolved from the registry | Deterministic reference prices; RPC failure degrades to sim |
| FDC attestation | `POST <FLARE_FDC_VERIFIER_URL>/Payment/prepareRequest` (`status:"VALID"` → verified) | Deterministic verified envelope, empty proof |
| Confidential score | Enclave remote-attestation quote from `FLARE_CC_ATTESTATION_URL` | `sim-tee` deterministic quote over the same commitments |
| On-chain execution | KeeperHub MCP with `KEEPERHUB_API_KEY` → real tx hash | Deterministic sim execution + audit trail |
| Vault | `Cred402FlareCreditVault.sol` deployed to Coston2 | `FlareSatelliteVault.ts` twin, rule-for-rule |

The privacy invariant, CAN verification, single-use nonce, and USD-denominated exposure cap
are **enforced identically** in both modes — only the price feed, attestation source, and
transaction broadcast differ.

## Autonomous Credit Keeper (FTSO position health)

FTSO is not just the pricing oracle at draw time — it is the *ongoing* risk gauge. An
agent's FXRP debt is drawn in a volatile asset but capped in USD, so the live FTSO XRP/USD
price continuously re-marks that debt: if XRP appreciates, the same FXRP debt is worth more
dollars and eats into the agent's cap. The **Autonomous Credit Keeper** turns that into a
single health factor and, on a margin call, autonomously executes a protective deleverage
through KeeperHub — the FTSO/risk half of a feature whose execution half lives in
[keeperhub_integration.md](keeperhub_integration.md).

```text
  health_factor    = usd_cap / current_debt_usd
  current_debt_usd = fxrp_debt × FTSO(XRP/USD)      (marked to the live oracle)
```

`PositionEngine` (`lib/flare/positions.ts`) classifies each position — `healthy` (HF ≥ 1.3),
`watch`, `margin_call` (HF < 1.15), `liquidation` (HF < 1.0) — and computes the exact FXRP
to repay to restore the 1.5 target. `CreditKeeper` (`lib/flare/keeper.ts`) checks then
executes; it only ever repays existing debt, so it is safe to run unattended over a fleet.
Pass a what-if XRP/USD price (`?price=` / `price_usd` / `priceOverride`) to stress-test a
position without waiting for the market to move.

```bash
npm run keeper:run   # margin call at HF 1.13 → deleverage ~2,089 FXRP → cured at HF 1.50 → 2× stress test
```

Surfaces: `cred402.flare_position` · `cred402.keeper_evaluate` · `cred402.keeper_run` ·
`cred402.keeper_run_fleet` (MCP); `GET /v1/agents/:id/position?price=`,
`GET /v1/keeper/evaluate/:id`, `POST /v1/keeper/run`, `POST /v1/keeper/run-fleet` (REST);
the console Keeper panel (`GET /api/keeper`, `POST /api/demo/keeper`). Full write-up:
[credit_keeper.md](credit_keeper.md).

## FTSO-priced collateral (borrowing power)

FTSO prices more than the FXRP debt — it prices the *collateral* that backs it. An agent's
reputation sets a base USD cap; posting collateral in several assets (USDC, BTC, ETH, XRP,
FLR) expands its borrowing power beyond that cap. Each asset is marked to its live FTSO feed
and discounted by a per-asset LTV haircut (volatile assets advance less), so the extra
power is `Σ collateral_usd × ltv`. This is Flare's multi-feed FTSO oracle pricing a basket
of heterogeneous assets on-chain — turning agent credit into a real over-collateralized
primitive.

```text
  borrowing_power_usd = cap_usd + Σ(collateral_value_usd × LTV)
  health_factor       = borrowing_power_usd / debt_usd
```

Collateral is additive: no collateral → borrowing power is just the reputation cap, so prior
behavior (and tests) are unchanged. Because the keeper and automations now assess against
borrowing power, **posting collateral can cure a margin call with no repay**. `CollateralVault`
(`lib/flare/collateral.ts`) is exposed via `cred402.deposit_collateral` /
`cred402.collateral_value` (MCP), `GET|POST /v1/agents/:id/collateral` (+ `/withdraw`) (REST),
and the console Collateral panel (`GET /api/collateral`, `POST /api/demo/collateral`). Run it
with `npm run collateral:run`. Full write-up, asset table, and a worked
margin-call → post collateral → cured example: [collateral.md](collateral.md).

## FAssets mint → collateralize

FTSO prices FXRP and FDC attests the payment that backs it — but where does the FXRP an
agent posts as collateral come from in the first place? **FAssets.** An agent that holds
real XRP (a non-smart-contract asset) reserves minting on the FXRP AssetManager, pays the
underlying XRP on the XRP Ledger, the **FDC attests that XRPL payment**, and `executeMinting`
mints **FXRP 1:1** against the proof. The minted FXRP is then posted as FTSO-priced XRP
collateral (same XRP/USD feed, 60% LTV), expanding the agent's borrowing power with no repay
— so real XRP liquidity becomes usable agent working capital on Flare. Redemption burns FXRP
back to XRP.

```text
  XRP → reserveMinting (0.25% fee, 24h TTL) → pay XRPL → FDC attests → executeMinting → FXRP 1:1 → post as collateral
```

The fail-closed rule: on the live path an **unverified FDC attestation does not mint**.
`FAssetsMinter` (`lib/flare/fassets_mint.ts`) implements it; real behind
`FLARE_FDC_VERIFIER_URL` (attestation) + `FLARE_RPC_URL` / `FLARE_FXRP_ASSET_MANAGER`
(AssetManager), deterministic sim otherwise.

```bash
npm run fassets:mint   # reserve 5,000 XRP (fee 12.5 XRP) → FDC-attested mint 5,000 FXRP → collateral (power 0 → 1,560 USD) → redeem 1,000
```

Surfaces: `cred402.mint_fxrp` · `cred402.fassets_status` · `cred402.redeem_fxrp` (MCP);
`GET /v1/agents/:id/fassets`, `POST /v1/fassets/mint {agent_id,xrp,collateralize?}`,
`POST /v1/fassets/redeem` (REST); the console Flare-tab FAssets panel (`GET /api/fassets`,
`POST /api/demo/fassets`). Full write-up: [fassets.md](fassets.md).

## References

- Flare docs: FTSO <https://dev.flare.network/ftso/overview> · FDC
  <https://dev.flare.network/fdc/overview> · FAssets <https://dev.flare.network/fassets/overview>
  · Confidential Compute <https://dev.flare.network/network/guides/flare-confidential-compute>
- On-chain vault + deploy: [../contracts/flare/README.md](../contracts/flare/README.md)
- KeeperHub execution layer: [keeperhub_integration.md](keeperhub_integration.md)
- x402 payment flow: [x402_flow.md](x402_flow.md)
