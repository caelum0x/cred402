# Autonomous Credit Keeper — FTSO risk → KeeperHub execution

> **Agents' FXRP debt carries live FTSO price risk. The keeper CHECKS each position
> against the FTSO oracle and, on a margin call, autonomously EXECUTES a protective
> deleverage through KeeperHub.** This is where both hackathons meet: Flare prices the
> risk (FTSO XRP/USD), KeeperHub lands the fix (simulate → smart gas → private routing →
> audit). Because it only ever repays existing debt, it is safe to run unattended over a
> whole fleet.

An agent draws its credit line in the FAsset **FXRP**, but its creditworthiness cap is
denominated in **USD**. FXRP is volatile, so the USD value of an outstanding FXRP debt
moves with the live FTSO XRP/USD price: if XRP appreciates, the same FXRP debt is worth
more dollars and eats further into the agent's cap. Left alone, a position that was safe
at draw time can silently breach its cap. The keeper closes that loop — it turns price
risk into a single monitorable health factor and, when the factor breaches the margin-call
line, executes exactly the deleverage that cures it.

The two seams:

- **Flare = risk pricing.** `PositionEngine` (`lib/flare/positions.ts`) marks the FXRP
  debt to the live FTSO XRP/USD feed and derives a health factor.
- **KeeperHub = reliable execution.** `CreditKeeper` (`lib/flare/keeper.ts`) hands the
  protective repay to KeeperHub's `execute_check_and_execute` pattern — condition
  detected on-chain, protective action executed on-chain, every step audited.

---

## The health-factor model

The engine values the debt in USD off the FTSO oracle and compares it to the agent's USD
cap:

```text
  current_debt_usd = fxrp_debt × FTSO(XRP/USD)     (marked to the live oracle)
  health_factor    = usd_cap / current_debt_usd    (> 1 = within cap; ∞ when no debt)
```

`usd_cap` is the agent's global-exposure `max_allowed` (the same USD denominator every
satellite shares); the engine also reports `price_drift_usd` — how far the FTSO-marked
debt has drifted from the USD recorded on the Casper root at draw time.

### The four statuses (`DEFAULT_THRESHOLDS`)

| Status | Condition | Meaning |
|---|---|---|
| `healthy` | HF ≥ **1.3** (`watch`) | Comfortable headroom. |
| `watch` | **1.15** ≤ HF < 1.3 | Surface a warning; no action yet. |
| `margin_call` | **1.0** ≤ HF < 1.15 | The keeper must deleverage. |
| `liquidation` | HF < **1.0** | Underwater — debt exceeds the cap. |
| `no_debt` | `fxrp_debt == 0` | Nothing to manage (HF ∞). |

Thresholds are configurable per keeper (`KeeperOptions.thresholds`); the defaults above
are `watch: 1.3, marginCall: 1.15, liquidation: 1.0, target: 1.5`.

### The required-deleverage math

On a margin call (or worse), the engine computes the exact FXRP to repay to restore the
**target** health factor (default 1.5):

```text
  target_debt_usd = cap_usd / target_hf            (cap / 1.5)
  repay_usd       = max(0, debt_usd − target_debt_usd)
  repay_fxrp      = repay_usd / FTSO(XRP/USD)       (clamped to the actual FXRP debt)
```

Only a `margin_call` or `liquidation` yields a non-zero `deleverage_fxrp`; a `watch` or
`healthy` position returns `0`. The repay is always capped at the FXRP the agent actually
drew — the keeper never invents liquidity, it only unwinds an existing position.

---

## The check → execute pipeline

`CreditKeeper` implements exactly KeeperHub's `execute_check_and_execute` pattern
(condition → on-chain action):

1. **Check.** `evaluate(agentId)` calls `PositionEngine.assess`, marks the debt to the
   live FTSO price, and decides: `deleverage` (with the exact `amount_fxrp` and a
   human-readable reason) when the position is a `margin_call`/`liquidation` with a
   positive required deleverage, else `none`.
2. **Execute.** `run(agentId)` runs the check and, if a protective action is due,
   executes the repay through the Flare satellite — which routes it through KeeperHub
   (`execute_contract_call` with `simulate:true` preflight → smart gas with exponential
   backoff → MEV-protected private routing → poll to a tx hash). The repay is capped at
   the agent's actual FXRP debt inside the vault.
3. **Audit.** Every execution appends an immutable KeeperHub audit record; `run` returns
   the `tx_hash`, the Blockscout `explorer_url`, and the `keeperhub_audit_id`. The full
   trail is queryable at `/v1/keeperhub/audit` and `cred402.keeperhub_audit`.

**Rollback-on-failure safety.** KeeperHub simulates before it broadcasts: a revert reason
short-circuits the whole execution and is recorded as `failed` — nothing is broadcast, so
a failed protective action never half-applies. On transient congestion / cold upstream it
retries with the **same idempotency key**, so a cold upstream never double-submits. And
because the keeper only ever *repays* FXRP the agent already drew, the worst case of an
unattended run is a no-op, never new leverage. See
[keeperhub_integration.md](keeperhub_integration.md) for the full execution envelope.

`runFleet(agentIds)` applies `run` across a whole fleet and returns per-agent results plus
a rollup (`evaluated`, `actioned`, `executed`, `total_deleveraged_fxrp`, `by_status`).

---

## Worked example

`npm run keeper:run` (`scripts/keeper_run.ts`) runs the keeper end to end — sim by default
(no keys, no network), real FTSO + real KeeperHub execution behind `FLARE_RPC_URL` /
`KEEPERHUB_API_KEY`:

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Cred402 Autonomous Credit Keeper — FTSO risk → KeeperHub execution │
└──────────────────────────────────────────────────────────────────────┘

● Scene 1 — Agent draws 8,500 FXRP — position at risk
  debt 8500 FXRP ≈ $4420 (FTSO $0.52, sim)
  cap $5000 · health factor 1.13 · status MARGIN_CALL
  draw tx 0x7c888deecc84e1f6…

● Scene 2 — Keeper: check → execute (deleverage via KeeperHub)
  decision: DELEVERAGE 2089.74 FXRP
  health factor 1.13 < margin-call 1.15; FTSO XRP/USD $0.52 marks the FXRP debt at $4420 (drift $0). Repay 2089.74 FXRP to restore HF ≥ 1.5.
  executed=true ok=true tx 0x2429cfbc25edbbc2… audit 0xc88ed98a2472cb2f329d179a08025f48
  explorer https://coston2-explorer.flare.network/tx/0x2429cfbc25edbbc2b69e6ef8787aef606d6eda712bea76233dfcd6e2d343d160

● Scene 3 — Position cured
  debt now 6410.26 FXRP ≈ $3333.34 · health factor 1.50 · status HEALTHY

● Scene 4 — Stress test — what if XRP/USD = $1.04
  debt would be $6666.67 · health factor 0.75 · status LIQUIDATION
  keeper would deleverage 3205.13 FXRP

● Scene 5 — KeeperHub reliability
  {"total":2,"confirmed":2,"failed":0,"private_routed":2,"sponsored":0,"avg_backoff_attempts":1,"total_gas_used":196800,"by_protocol":{"x402":2}}
```

Reading it end to end:

- **Scene 1 — risk.** The agent draws 8,500 FXRP. At the FTSO XRP/USD price of $0.52 that
  debt is worth $4,420 against a $5,000 cap → HF 1.13, which is below the 1.15 margin-call
  line: `MARGIN_CALL`.
- **Scene 2 — check → execute.** The keeper detects the breach and autonomously
  deleverages **2,089.74 FXRP** — exactly `debt − cap/1.5 = $4,420 − $3,333.33 = $1,086.67`
  worth, priced at $0.52. It executes through KeeperHub (`executed=true ok=true`) with a
  real tx hash, Blockscout link, and audit id.
- **Scene 3 — cured.** Post-repay the debt is 6,410.26 FXRP ≈ $3,333.34, HF back at exactly
  **1.50**: `HEALTHY`.
- **Scene 4 — stress test.** The `priceOverride` what-if doubles XRP/USD to $1.04: the same
  cured debt would be worth $6,666.67, HF 0.75 → `LIQUIDATION`, and the keeper would
  deleverage a further 3,205.13 FXRP. This is a hypothetical, marked `what-if` — nothing is
  executed.
- **Scene 5 — reliability.** Two KeeperHub executions (the draw + the deleverage), both
  confirmed, both private-routed, one gas-backoff attempt each, settled over x402.

---

## Surfaces

The identical engine + keeper is exposed on every Cred402 surface. The stress-test
what-if price is available everywhere: `?price=` on the REST position route, `price_usd`
on the MCP position tool, and the `priceOverride` option in code.

### MCP tools (`mcp/tools.ts`)

| Tool | Purpose |
|---|---|
| `cred402.flare_position` | FTSO position health for an agent's FXRP debt: USD-marked debt, health factor vs the USD cap, price-risk drift, status, and the FXRP deleverage needed to cure a margin call. Pass `price_usd` to stress-test at a hypothetical XRP price. |
| `cred402.keeper_evaluate` | Evaluate **only** (no execution): what protective action the keeper would take for an agent, with the reason. |
| `cred402.keeper_run` | Check then **execute**: if the position is in a margin call, autonomously deleverage through KeeperHub. Only ever repays existing debt. |
| `cred402.keeper_run_fleet` | Run the keeper across every registered agent — per-agent decisions + executions and a rollup. |

### /v1 endpoints (`api/v1/router.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/agents/:id/position?price=` | FTSO position health for the agent; optional `?price=` for a what-if XRP/USD stress test. |
| `GET` | `/v1/keeper/evaluate/:id` | What the keeper would do for one agent (no execution). |
| `POST` | `/v1/keeper/run` | `{ agent_id }` → check + execute a protective deleverage via KeeperHub. |
| `POST` | `/v1/keeper/run-fleet` | Run the keeper across the whole fleet; per-agent results + rollup. |

### Console (`api/server.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/keeper` | Read-only fleet evaluation (dry-run, never executes) — safe to poll for the Keeper panel. |
| `POST` | `/api/demo/keeper` | One-click demo: draw a large FXRP position that trips a margin call, then let the keeper deleverage it via KeeperHub (`before` / `after` positions + reliability). |

### Script

```bash
npm run keeper:run          # scripts/keeper_run.ts — the full margin-call → deleverage → stress-test demo
```

---

## What's real vs sim

Following the repo's *real-behind-env + deterministic sim* convention — same return shapes
either way, so the demo and tests run with zero keys:

| Capability | Real (env set) | Sim (default) |
|---|---|---|
| FTSO price (risk) | `FtsoV2.getFeedById` `eth_call` via `FLARE_RPC_URL` | Deterministic reference (`XRP/USD = $0.52`); RPC failure degrades to sim |
| KeeperHub execution (the fix) | MCP-over-HTTP to `https://app.keeperhub.com/mcp` with `KEEPERHUB_API_KEY` → real tx hash | Deterministic sim execution + audit trail |

The health-factor model, the margin-call classification, the required-deleverage math, and
the "only ever repay existing debt" safety rule are **enforced identically** in both modes
— only the price feed and the transaction broadcast differ.

## Credit Automations (declarative policies)

The keeper is **reactive** — a fleet-wide safety net that watches every position and, on a
margin call (HF < 1.15), executes the exact deleverage that cures it. **Credit Automations**
are the **declarative** counterpart: they let a specific agent (or operator) commit its OWN
policy up front — `price_below`/`price_above` on the FTSO XRP/USD feed, `health_below` on
the FTSO-priced health factor, or a `schedule` rendered to a KeeperHub cron → a
`deleverage`/`repay`/`notify` action — and have KeeperHub run it on a schedule or on a
trigger, before the position ever breaches.

Both land the same protective repay through the same KeeperHub execution seam
(simulate → smart gas → private routing → audit) and share the same safety property — they
only ever repay FXRP the agent already drew, so an unattended run is at worst a no-op. The
difference is who authored the condition and when: the keeper fires on the margin-call line;
an automation fires on the agent's own declared trigger. Full write-up, model, surfaces, and
a worked declare → tick → cured → idempotent example: [credit_automations.md](credit_automations.md).

## Collateral-aware health factor

The health factor divides the debt against **borrowing power**, not the reputation cap
alone. An agent can post FTSO-priced collateral (USDC/BTC/ETH/XRP/FLR, each discounted by a
per-asset LTV haircut) to expand that power:

```text
  borrowing_power_usd = cap_usd + Σ(collateral_value_usd × LTV)
  health_factor       = borrowing_power_usd / debt_usd
```

So the keeper and Credit Automations now assess every position against `cap + collateral`.
The practical consequence: **posting collateral is an alternative to deleveraging.** Where
the keeper's only cure for a margin call is to repay FXRP (shrinking the debt), an agent can
instead post collateral (growing the borrowing power) and lift the health factor above the
margin-call line with no repay — two ways to raise the same ratio. Collateral is additive:
an agent with none has `collateral_usd = 0`, borrowing power collapses to the reputation
cap, and the keeper behaves exactly as before. Full model, asset table, and a worked
margin-call → post collateral → cured example: [collateral.md](collateral.md).

## Running the keeper on a cadence

The keeper is a *check → execute* engine, but it still needs something to invoke it on a
clock. The [Autonomous Scheduler](scheduler.md) is that heartbeat: it registers a
`keeper-sweep` job that runs `runFleet(...)` across every registered agent every 60s (next
to a 30s `automation-tick` job), so the fleet-wide safety net operates unattended — no cron
job, no human, no missed margin call.

The scheduler is **default OFF** and stops on a ledger reset, precisely because a live sweep
executes real protective deleverages through KeeperHub; you opt in with
`POST /v1/scheduler/start` (or the Flare tab Scheduler panel). The sweep inherits the
keeper's safety property — it only ever repays FXRP an agent already drew, so a sweep of a
healthy fleet is a no-op. Full model, surfaces, and a worked cadence example:
[scheduler.md](scheduler.md).

## References

- Risk pricing (FTSO position health): [flare_integration.md](flare_integration.md)
- Execution layer (check → execute): [keeperhub_integration.md](keeperhub_integration.md)
- Engine: `lib/flare/positions.ts` · Keeper: `lib/flare/keeper.ts` · Demo:
  `scripts/keeper_run.ts`