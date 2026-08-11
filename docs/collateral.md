# FTSO-priced collateral — borrowing power for agent credit

> **Reputation gives an agent a base USD cap; posting collateral expands it.** An agent
> can post several assets — USDC, BTC, ETH, XRP, FLR — each marked to its live **FTSO**
> feed and discounted by a per-asset **LTV** haircut. The LTV-weighted USD value adds to
> the reputation cap to form the agent's **borrowing power**. This is Flare's multi-feed
> FTSO oracle doing exactly what it is for: pricing a basket of heterogeneous assets
> on-chain, with no third-party price API, turning agent credit into a real
> over-collateralized primitive.

An agent's Flare credit line is drawn in the FAsset **FXRP** but capped in **USD** by its
creditworthiness. Reputation sets that cap; it does not have to be the only source of
borrowing power. `CollateralVault` (`lib/flare/collateral.ts`) lets an agent post
collateral in several assets and expands its borrowing power by the LTV-weighted USD value
of the basket — so a position that trips a margin call against the reputation cap alone can
be cured by posting collateral instead of repaying debt.

---

## The model

Borrowing power is additive: the reputation cap plus the LTV-haircut value of every posted
asset. The health factor is the same as before — it just divides against the larger
denominator.

```text
  collateral_usd      = Σ (asset_amount × FTSO(asset/USD) × LTV)   (per-asset haircut)
  borrowing_power_usd = cap_usd + collateral_usd
  health_factor       = borrowing_power_usd / debt_usd             (> 1 = within power; ∞ when no debt)
```

Each asset is valued at its live FTSO price, then discounted by its LTV advance rate:
volatile assets advance less. The result (`value_usd × ltv`) is that asset's contribution
to borrowing power.

### Supported assets (`COLLATERAL_ASSETS`)

| Symbol | FTSO feed | Decimals | LTV | Rationale |
|---|---|---|---|---|
| `USDC` | `USDC/USD` | 6 | **95%** | Stable — advances almost par. |
| `BTC` | `BTC/USD` | 8 | **80%** | Deep, liquid, but volatile. |
| `ETH` | `ETH/USD` | 18 | **75%** | Liquid, more volatile than BTC. |
| `XRP` | `XRP/USD` | 6 | **60%** | Native to the FXRP debt asset; heavier haircut. |
| `FLR` | `FLR/USD` | 18 | **40%** | Flare-native, most volatile — most conservative advance. |

Deposits are held per agent, in each asset's smallest units (`amount_whole × 10^decimals`).
Valuation is live FTSO with the deterministic sim reference price as a fallback — identical
shape either way, so the demo and tests run with no keys.

### Additive by design — no collateral means unchanged behavior

Collateral is strictly additive. `PositionEngine` (`lib/flare/positions.ts`) takes an
optional collateral source; when an agent has posted nothing (or no vault is wired),
`collateral_usd` is `0`, `borrowing_power_usd` collapses to `cap_usd`, and the health
factor is exactly what it was before this feature. Existing behavior and tests stay green —
collateral only ever raises borrowing power, never lowers it.

---

## Integration — the keeper and automations assess against borrowing power

The Autonomous Credit Keeper and Credit Automations classify positions off the health
factor, and that health factor is now `borrowing_power_usd / debt_usd`. Two consequences:

- **Posting collateral can cure a margin call with NO repay.** Where the keeper's only cure
  used to be deleveraging (repaying FXRP), an agent can now expand borrowing power by
  posting collateral and lift the health factor above the margin-call line without touching
  its debt. Deleveraging and collateralizing are two ways to raise the same ratio — one
  shrinks the numerator's debt, the other grows the denominator's power.
- **The what-if price stress test still applies.** The FTSO XRP/USD `priceOverride` re-marks
  the FXRP debt at a hypothetical price and recomputes the health factor against the
  collateral-expanded borrowing power — so you can ask "does my collateral still hold if XRP
  rallies 50%?" before the market moves.

---

## Worked example

`npm run collateral:run` (`scripts/collateral_run.ts`) runs the flow end to end — sim by
default (no keys, no network), real FTSO behind `FLARE_RPC_URL`:

```text
┌────────────────────────────────────────────────────┐
│ Cred402 collateral — FTSO-priced borrowing power │
└────────────────────────────────────────────────────┘

● Scene 1 — Draw 8,500 FXRP — over the reputation cap
  debt $4420 vs cap $5000 (collateral $0) → borrowing power $5000
  health factor 1.13 · status MARGIN_CALL

● Scene 2 — Post collateral (USDC + BTC + ETH), valued by FTSO
  0.03 BTC @ $64000 (sim) = $1920 → $1536 power (LTV 80%)
  0.5 ETH @ $3200 (sim) = $1600 → $1200 power (LTV 75%)
  1500 USDC @ $1 (sim) = $1500 → $1425 power (LTV 95%)
  total collateral value $5020 → borrowing power +$4161

● Scene 3 — Position after collateral
  borrowing power now $9161 (cap $5000 + collateral $4161)
  health factor 1.13 → 2.07 · status HEALTHY — cured with no repay

● Scene 4 — Stress — XRP/USD +50% to $0.78
  debt would be $6630 · HF 1.38 · status HEALTHY
```

Reading it end to end:

- **Scene 1 — margin call.** The agent draws 8,500 FXRP. At the FTSO XRP/USD price of $0.52
  that debt is worth $4,420 against a $5,000 reputation cap → HF 1.13, below the 1.15
  margin-call line: `MARGIN_CALL`. No collateral yet, so borrowing power equals the cap.
- **Scene 2 — post collateral.** The agent posts three assets. Each is priced by FTSO
  (0.03 BTC @ $64,000, 0.5 ETH @ $3,200, 1,500 USDC @ $1) and discounted by its LTV:
  $1,536 + $1,200 + $1,425. A $5,020 gross basket contributes **+$4,161** of borrowing power.
- **Scene 3 — cured, no repay.** Borrowing power rises to $9,161 (cap $5,000 + collateral
  $4,161). The same $4,420 debt now divides against $9,161 → HF **2.07**, `HEALTHY`. The
  margin call is cured without repaying a single FXRP.
- **Scene 4 — stress test.** The `priceOverride` what-if rallies XRP/USD +50% to $0.78: the
  FXRP debt would be worth $6,630, but against the $9,161 collateral-expanded power the HF is
  still 1.38 → `HEALTHY`. This is hypothetical, marked `what-if` — nothing is executed.

---

## Surfaces

The identical vault + engine is exposed on every Cred402 surface.

### MCP tools (`mcp/tools.ts`)

| Tool | Purpose |
|---|---|
| `cred402.deposit_collateral` | Post FTSO-priced collateral (USDC/BTC/ETH/XRP/FLR) to expand an agent's borrowing power. Each asset is marked to its live FTSO feed and discounted by an LTV haircut; the resulting borrowing power is added to the reputation cap in the agent's position health. Returns the new balance + basket valuation. |
| `cred402.collateral_value` | Value an agent's posted collateral basket in USD via FTSO, with per-asset LTV haircuts, plus the total borrowing power it contributes. |

### /v1 endpoints (`api/v1/router.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/agents/:id/collateral` | The agent's collateral basket valued in USD via FTSO, with per-asset LTV haircuts and total borrowing power. |
| `POST` | `/v1/agents/:id/collateral` | `{ symbol, amount }` → deposit collateral; returns the new balance, basket valuation, and the updated position. |
| `POST` | `/v1/agents/:id/collateral/withdraw` | `{ symbol, amount }` → withdraw collateral (reverts on insufficient balance); returns the new balance, valuation, and updated position. |

### Console (`api/server.ts` + `api/state.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/collateral` | Read-only view for the Flare tab Collateral panel: the seller's basket valuation + current position. Safe to poll. |
| `POST` | `/api/demo/collateral` | One-click demo: open a margin-called FXRP position, then post 3,000 USDC (+$2,850 borrowing power at 95% LTV) to cure it — `before` / `after` positions + valuation, no repay. |

State methods: `collateralView`, `runCollateralDemo`, and the underlying
`depositCollateral` / `withdrawCollateral` / `collateralValue`.

### Script

```bash
npm run collateral:run      # scripts/collateral_run.ts — the full margin-call → post collateral → cured → stress-test demo
```

---

## What's real vs sim

Following the repo's *real-behind-env + deterministic sim* convention — same return shapes
either way, so the demo and tests run with zero keys:

| Capability | Real (env set) | Sim (default) |
|---|---|---|
| Collateral pricing | Each asset's `FtsoV2.getFeedById` `eth_call` via `FLARE_RPC_URL`, FtsoV2 resolved from the FlareContractRegistry | Deterministic FTSO reference prices per feed; RPC failure degrades to sim |

The LTV haircuts, per-agent deposit accounting, and the additive `cap + collateral`
borrowing-power model are **enforced identically** in both modes — only the price feed
differs.

---

## Bringing XRP as collateral (FAssets)

The XRP collateral asset in the table above does not have to be XRP an agent already holds
on Flare — it can be **minted on demand from real XRP** via FAssets. An agent reserves
minting on the FXRP AssetManager, pays the underlying XRP on the XRP Ledger, the FDC attests
that payment, and `executeMinting` mints **FXRP 1:1**. Because FXRP is XRP bridged 1:1 on the
same XRP/USD feed, that minted FXRP is posted straight into the `CollateralVault` as the
**XRP** asset (60% LTV) — expanding borrowing power with no repay and no new debt.

```text
  real XRP → mint FXRP (FDC-attested, 1:1) → post as XRP collateral → borrowing power +$= fxrp_whole × FTSO(XRP/USD) × 0.60
```

This closes the interoperable-asset loop: real XRP liquidity becomes on-chain agent working
capital that backs a credit line. `mintAndCollateralize` (`api/state.ts`) does the whole loop
in one call; `cred402.mint_fxrp` with `collateralize=true` (MCP) and
`POST /v1/fassets/mint {collateralize:true}` (REST) expose it. Full lifecycle, state machine,
fail-closed attestation rule, and a worked example: [fassets.md](fassets.md).

---

## References

- FAssets mint → collateralize (where minted FXRP collateral comes from): [fassets.md](fassets.md)
- Risk engine + health factor: [credit_keeper.md](credit_keeper.md)
- FTSO oracle, FXRP, and the wider Flare satellite: [flare_integration.md](flare_integration.md)
- Vault: `lib/flare/collateral.ts` · Engine: `lib/flare/positions.ts` · Demo:
  `scripts/collateral_run.ts`
