# FAssets — mint FXRP from attested XRP, then collateralize

> **FAssets brings a non-smart-contract asset (XRP) onto Flare as a first-class
> ERC-20 (FXRP, 1:1).** An agent reserves minting on the FXRP AssetManager, pays the
> underlying XRP on the XRP Ledger, the **FDC** attests that XRPL payment, and
> `executeMinting` mints FXRP against the proof; redemption burns FXRP and releases the
> XRP. For Cred402 this closes the interoperable-asset loop: an agent brings real XRP
> liquidity, mints **FDC-attested** FXRP, and posts it as **FTSO-priced collateral** to
> expand its credit line — XRP becomes usable agent working capital on Flare.

The Flare satellite already lends FXRP against a Casper-signed Credit Authorization Note
(see [flare_integration.md](flare_integration.md)). FAssets is the step *before* that:
where the FXRP itself comes from. An agent that holds real XRP — a non-smart-contract
asset with deep liquidity but no native EVM presence — can turn it into on-chain working
capital: mint FXRP 1:1, then post that FXRP as collateral to raise its borrowing power.
`FAssetsMinter` (`lib/flare/fassets_mint.ts`) implements the mint → redeem lifecycle;
`FXRP` and `fxrpToXrp` (`packages/chain-adapters/src/adapters/flare/fassets.ts`) model the
asset; `FdcClient.attestPayment` (`.../flare/fdc.ts`) attests the underlying XRPL payment.

---

## The lifecycle

```text
  Agent holds real XRP (a non-smart-contract asset)
        │
        ▼
  reserveMinting(agent, xrpDrops)                      (FXRP AssetManager: reserveCollateral)
        │   → reservation id, payment address, 0.25% reservation fee, 24h TTL
        ▼
  Agent pays the underlying XRP on the XRP Ledger      (to the reservation's payment address)
        │
        ▼
  FDC attests the XRPL payment                         (fdc.ts — Payment attestation)
        │   → verified proof the payment really settled
        ▼
  executeMinting(reservation, xrplTxHash)              (AssetManager: executeMinting w/ proof)
        │   → FXRP minted 1:1, credited to the agent
        ▼
  Post FXRP as FTSO-priced collateral                  (CollateralVault, XRP/USD feed, 60% LTV)
        │   → borrowing power expands, no repay, no new debt
        ▼
  redeem(agent, fxrpDrops)                             (burns FXRP → opens an XRPL redemption)
```

### State machine

A mint reservation is a small state machine (`MintStatus`):

```text
  reserved ──executeMinting(verified)──▶ minted ──redeem──▶ (FXRP burned back to XRP)
      │
      └── now > expires_at ─────────────▶ expired      (executeMinting reverts)
```

- **`reserved`** — the agent has committed to depositing `underlying_drops` of XRP; the
  AssetManager returns a `payment_address` and charges a **collateral reservation fee of
  0.25%** (`RESERVATION_FEE_BPS = 25`) up front. The reservation carries a **24-hour TTL**
  (`RESERVATION_TTL_SEC = 24 × 3600`).
- **`minted`** — the XRPL payment has been made and FDC-attested, and `executeMinting`
  credited FXRP **1:1** (`fxrp_amount === underlying_drops`, both 6-dp smallest units).
- **`expired`** — the TTL elapsed before minting; `executeMinting` marks it `expired` and
  reverts. A reservation can only be minted once (a second call reverts
  `reservation already minted`).

### The fail-closed rule

On the **live path** an unverified FDC attestation does **not** mint. `executeMinting`
requests a `Payment` attestation for the XRPL tx and, when the FDC client is live
(`FLARE_FDC_VERIFIER_URL` set), refuses to mint unless the attestation verifies:

```ts
const attestation = await this.fdc.attestPayment({ attestationType: "Payment", sourceId, transactionId: xrplTxHash });
// On the live path an unverified attestation must not mint (fail closed).
if (this.fdc.isLive() && !attestation.verified) {
  throw new Error(`FDC could not verify XRPL payment ${xrplTxHash}`);
}
```

In sim the attestation is a deterministic verified envelope, so the loop runs with no
verifier and no XRPL — the shape (`fdc_attestation_id`, `fdc_verified`, `fdc_source`) is
identical either way, only `source` reads `sim` vs `fdc`.

---

## How it connects — minted FXRP becomes borrowing power

FXRP is XRP bridged 1:1, so minted FXRP is posted to the `CollateralVault` as the **XRP**
collateral asset, priced by the **same live FTSO XRP/USD feed** and discounted by XRP's
**60% LTV** haircut. Posting collateral is additive to the agent's reputation cap:

```text
  borrowing_power_usd = cap_usd + Σ(collateral_value_usd × LTV)
  # for minted FXRP posted as XRP:  + fxrp_whole × FTSO(XRP/USD) × 0.60
```

So the mint → collateralize loop expands an agent's borrowing power **with no repay and no
new debt** — and, because the keeper and automations assess against borrowing power, it can
even cure a margin call. See [collateral.md](collateral.md) for the collateral model and
LTV table, and [credit_keeper.md](credit_keeper.md) for how borrowing power feeds position
health and the Autonomous Credit Keeper.

---

## Worked example

`npm run fassets:mint` (`scripts/fassets_mint_run.ts`) runs the loop end to end — sim by
default (no keys, no XRPL, no network), real FDC behind `FLARE_FDC_VERIFIER_URL` and real
FTSO collateral pricing behind `FLARE_RPC_URL`:

```text
┌─────────────────────────────────────────────────────────────────┐
│ Cred402 FAssets — mint FXRP from attested XRP → collateralize │
└─────────────────────────────────────────────────────────────────┘

● Scene 1 — Reserve minting on the FXRP AssetManager
  reservation cr-7c2b661f00af · pay 5000 XRP → r64797401e2c9a324aec24eef20d11fb5
  reservation fee 12.5 XRP · will mint 5000 FXRP

● Scene 2 — FDC attests the XRPL payment → executeMinting
  minted 5000 FXRP (balance 5000)
  FDC attestation 0x653d413e7b9e7876… · verified true · source sim

● Scene 3 — Post minted FXRP as FTSO-priced collateral
  collateral value $2600 → borrowing power +$1560
  borrowing power 0 → 1560 USD (no repay, no new debt)

● Scene 4 — Redeem 1,000 FXRP → XRP
  burned 1000 FXRP · XRPL redemption rdm:517ce3ae1d6251…
  FXRP balance now 4000

● Scene 5 — FAssets supply
  circulating FXRP: 4000
```

Reading it end to end:

- **Scene 1 — reserve.** The agent reserves minting for 5,000 XRP. The AssetManager returns
  a `payment_address` to deposit the XRP to and charges a **0.25% reservation fee = 12.5
  XRP**. It will mint 5,000 FXRP (1:1).
- **Scene 2 — attest + mint.** The agent's XRPL payment is attested by the FDC (here `source
  sim`, `verified true`; on the live path `source fdc` from a real verifier), and
  `executeMinting` mints **5,000 FXRP** to the agent's balance.
- **Scene 3 — collateralize.** The 5,000 FXRP is posted as XRP collateral. At the FTSO
  XRP/USD price of $0.52 the basket is worth **$2,600**; discounted by XRP's 60% LTV it adds
  **+$1,560** of borrowing power — taking the agent from 0 → **1,560 USD**, with no repay and
  no new debt.
- **Scene 4 — redeem.** The agent redeems **1,000 FXRP** back to XRP: the FXRP is burned and
  an XRPL redemption ticket is opened, leaving a **4,000 FXRP** balance.
- **Scene 5 — supply.** Circulating FXRP (the FAsset's minted supply here) is **4,000** —
  5,000 minted minus 1,000 redeemed.

---

## Surfaces

The identical `FAssetsMinter` is exposed on every Cred402 surface.

### MCP tools (`mcp/tools.ts`)

| Tool | Purpose |
|---|---|
| `cred402.mint_fxrp` | Mint FXRP from XRP: reserve minting, FDC-attest the XRPL payment, execute minting 1:1. Set `collateralize=true` to immediately post the minted FXRP as FTSO-priced collateral, expanding the agent's borrowing power (bring XRP → borrow). |
| `cred402.fassets_status` | FAssets status for an agent: FXRP balance, minting reservations, circulating FXRP supply, and whether the real FDC attestation path is live. |
| `cred402.redeem_fxrp` | Redeem FXRP back to underlying XRP: burns FXRP and opens an XRPL redemption ticket. |

### /v1 endpoints (`api/v1/router.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/agents/:id/fassets` | The agent's FAssets status: FXRP balance, mint reservations, circulating supply, and the FDC-live flag. |
| `POST` | `/v1/fassets/mint` | `{ agent_id, xrp, collateralize? }` → reserve + FDC-attest + executeMinting. With `collateralize: true`, also posts the minted FXRP as XRP collateral and returns the `before`/`after` position + valuation. |
| `POST` | `/v1/fassets/redeem` | `{ agent_id, fxrp }` → burn FXRP, open an XRPL redemption (reverts on insufficient balance). |

### Console (`api/server.ts` + `api/state.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/fassets` | Read-only view for the Flare tab FAssets panel: the seller's FXRP balance, reservations, circulating supply, and FDC-live flag. Safe to poll. |
| `POST` | `/api/demo/fassets` | One-click demo: mint the seller's XRP (`{ xrp }`, default 3,000 in the API; the Flare tab button sends 5,000) into FXRP and post it as collateral — returns `mint`, `valuation`, and `before`/`after` positions. |

State methods: `mintFxrp`, `redeemFxrp`, `fassetsStatus`, and `mintAndCollateralize` (the
full bring-XRP → mint → collateralize loop). The Flare tab (`frontend/src/components/Flare.tsx`)
renders the FAssets panel with an FXRP balance chip, circulating supply, the FDC live/sim
badge, reservation count, and a **"Mint 5,000 XRP → FXRP → collateral"** button.

### Script

```bash
npm run fassets:mint      # scripts/fassets_mint_run.ts — the full reserve → attest → mint → collateralize → redeem demo
```

---

## What's real vs sim

Following the repo's *real-behind-env + deterministic sim* convention — same return shapes
either way, so the demo and tests run with zero keys:

| Capability | Real (env set) | Sim (default) |
|---|---|---|
| FDC attestation of the XRPL payment | `POST <FLARE_FDC_VERIFIER_URL>/Payment/prepareRequest` (`status:"VALID"` → verified); an unverified attestation does **not** mint | Deterministic verified `Payment` envelope, empty proof, `source: "sim"` |
| AssetManager reserve/execute | `reserveCollateral` / `executeMinting` on the FXRP AssetManager behind `FLARE_RPC_URL` + `FLARE_FXRP_ASSET_MANAGER` | Deterministic in-memory reservation state machine |
| Collateral pricing | `FtsoV2.getFeedById` `eth_call` via `FLARE_RPC_URL`, FtsoV2 resolved from the FlareContractRegistry | Deterministic FTSO reference (`XRP/USD = $0.52`) |

The 1:1 mint invariant, 0.25% reservation fee, 24-hour TTL, single-use reservation, and the
fail-closed attestation rule are **enforced identically** in both modes — only the
attestation source, AssetManager broadcast, and price feed differ. The XRPL source id for
the Payment attestation defaults to `testXRP` (`FLARE_FASSETS_SOURCE_ID`).

Acquire testnet **FXRP** (and C2FLR for gas) from the Coston2 faucet:
<https://faucet.flare.network/coston2>.

---

## References

- Flare satellite, FTSO, FDC, and the FXRP credit vault: [flare_integration.md](flare_integration.md)
- Collateral model, LTV table, and borrowing power: [collateral.md](collateral.md)
- Risk engine, health factor, and the Autonomous Credit Keeper: [credit_keeper.md](credit_keeper.md)
- Minter: `lib/flare/fassets_mint.ts` · FXRP model: `packages/chain-adapters/src/adapters/flare/fassets.ts`
  · FDC client: `packages/chain-adapters/src/adapters/flare/fdc.ts` · Demo: `scripts/fassets_mint_run.ts`
- Flare docs: FAssets minting <https://dev.flare.network/fassets/minting> · FAssets overview
  <https://dev.flare.network/fassets/overview> · FDC <https://dev.flare.network/fdc/overview>
</content>
</invoke>
