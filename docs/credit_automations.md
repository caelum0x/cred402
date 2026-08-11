# Credit Automations — declare a policy, KeeperHub runs it

> **The Autonomous Credit Keeper *reacts* to a margin call. Credit Automations let an
> agent (or operator) declare its OWN policy up front — "if XRP/USD crosses $0.40,
> de-risk", "if my health factor drops below 1.4, deleverage to 2.0", "every hour, sweep
> and repay" — and have KeeperHub run it.** A declarative trigger → an on-chain action,
> executed with simulation, smart gas, private routing and an audit trail. This is the
> direct use of KeeperHub's workflow-builder + cron + check-and-execute surface.

The keeper (`lib/flare/keeper.ts`) is *reactive*: it watches every position and, on a
margin call, executes the exact deleverage that cures it. Automations are *declarative*:
they let a specific agent commit a rule ahead of time and have that rule evaluated and
executed on a schedule or on a price/health trigger — without waiting for the position to
breach. Both land the same protective repay through the same KeeperHub execution seam; the
difference is who authored the condition and when.

- **Keeper** — a fleet-wide safety net that fires on the margin-call line (HF < 1.15).
- **Automations** — a per-agent policy: *your* triggers, *your* target health factor,
  scheduled or price-driven, registered as a KeeperHub workflow.

The engine is `AutomationEngine` (`lib/flare/automations.ts`). It is the source of truth
for the declared rules and executes every action through the `FlareCreditSatellite` (→
KeeperHub). When a real `KEEPERHUB_API_KEY` is present, each automation is ALSO registered
as a KeeperHub workflow so it can be scheduled and managed there.

---

## The model

An automation is a **trigger → action** pair with an anti-spam cooldown
(`AutomationDef` in `lib/flare/automations.ts`).

### Triggers (`AutomationTrigger`)

| Trigger | Shape | Due when |
|---|---|---|
| `price_below` | `{ price }` | live FTSO XRP/USD **<** `price` |
| `price_above` | `{ price }` | live FTSO XRP/USD **>** `price` |
| `health_below` | `{ threshold }` | the position has FXRP debt **and** its FTSO-priced health factor **<** `threshold` |
| `schedule` | `{ every_seconds }` | at least `every_seconds` have elapsed since the last fire; rendered to a KeeperHub cron |

Price triggers read the same FTSO XRP/USD feed that prices every position
(`FXRP.ftso_feed`); `health_below` reads the FTSO-priced health factor from
`PositionEngine.assess`. A `health_below` rule never fires on a zero-debt position (there
is nothing to manage), which is what makes a cured position stop firing (see Idempotency).

`schedule` is rendered to a cron by `everySecondsToCron` — `every_seconds` is divided into
whole minutes (min 1) as `*/<minutes> * * * *`, so e.g. `3600` → `*/60 * * * *`.

### Actions (`AutomationAction`)

| Action | Shape | Effect |
|---|---|---|
| `deleverage` | `{ target_hf? }` | compute the FXRP to repay to reach `target_hf` via `PositionEngine.deleverageToTarget` (default **2.0**), then repay it through KeeperHub. A no-op when the position is already at/above target. |
| `repay` | `{ amount_fxrp }` | repay a fixed FXRP amount, clamped to the agent's actual FXRP debt. |
| `notify` | — | record a fire without moving value on-chain (alert-only). |

`deleverage` is the proactive form of the keeper's required-deleverage math:
`deleverageToTarget` returns `debt − cap/target_hf` worth of FXRP (priced at the live FTSO
XRP/USD), clamped to the debt, and returns **0** when the position is already at or above
the target. Because it only ever *repays* FXRP the agent already drew, an automation can
never add leverage — the worst case of an unattended run is a no-op.

### Cooldown / anti-spam

`cooldown_seconds` (default **60**) is the minimum gap between fires for threshold triggers
(`price_*`, `health_below`); for `schedule` the interval *is* the cooldown
(`every_seconds`). Within the cooldown window `isDue` returns `{ due: false, reason:
"cooldown" }`, so a rule can't thrash on a flickering price.

### Idempotency

A `deleverage` restores the position to `target_hf`; a `repay` reduces the debt. Once the
position is safe the trigger simply stops evaluating as due: `health_below` no longer sees
a sub-threshold health factor (and short-circuits entirely once the debt reaches zero), and
`deleverage` returns a **0** repay it treats as a satisfied no-op. Re-ticking a cured
position therefore performs no on-chain work — the policy converges and stays converged.

---

## The tick loop

`AutomationEngine.tick({ satellite, ledger })` is the evaluate-then-execute loop:

1. **Evaluate.** For every *enabled* automation, `PositionEngine.assess(agent_id)` marks
   the FXRP debt to the live FTSO XRP/USD price; `isDue` decides whether the trigger is met
   (respecting the cooldown).
2. **Execute.** Each due automation runs its action through the `FlareCreditSatellite`,
   i.e. `satellite.repay(agent, amount)` — which routes through KeeperHub's full envelope:
   preflight `simulate:true` → smart gas with exponential backoff → MEV-protected private
   routing → poll to a tx hash → append to the audit trail.
3. **Record.** `tick` returns one `AutomationRun` per fired automation — the trigger
   `reason`, the `action`, `amount_fxrp`, `ok`, `tx_hash`, `explorer_url` (Blockscout), and
   the `keeperhub_audit_id` — and bumps the automation's `last_fired_at` / `fire_count`.

The tick is the thing you schedule: call it from the console demo, the `/v1` route, the MCP
tool, or the script; on the live path KeeperHub can drive it from the registered workflow's
cron.

---

## KeeperHub workflow registration

When `KEEPERHUB_API_KEY` is set (`KeeperHubClient.isLive()`), `register` ALSO registers the
automation as a KeeperHub workflow via `create_workflow` — `name: cred402:<name>`, a
description of the `trigger → action`, and, for `schedule` triggers, the rendered cron
(validated first with `validate_cron`). The workflow is created with `enabled: false`: it
is registered but driven by Cred402's own `tick`, so you enable it in KeeperHub when you
want KeeperHub to schedule it. The returned `id` / `workflow_id` is kept on the automation
as `keeperhub_workflow_id`. Registration is best-effort — any failure leaves the automation
local-only and fully functional.

Without a key the whole flow runs in deterministic sim: no workflow id, but the identical
trigger evaluation, deleverage math, and audit trail.

---

## Worked example

`npm run automations:run` (`scripts/automations_run.ts`) runs the whole loop end to end —
sim by default (no keys, no network), real FTSO + real KeeperHub execution behind
`FLARE_RPC_URL` / `KEEPERHUB_API_KEY`:

```text
┌────────────────────────────────────────────────────────────────────┐
│ Cred402 Credit Automations — declare a policy, KeeperHub runs it │
└────────────────────────────────────────────────────────────────────┘

● Scene 1 — Declared automations
  guard-hf-1.4: health_below → deleverage (id auto-369e9450dddf)
  derisk-if-xrp-above-0.40: price_above → deleverage (id auto-a258d3cb1357)
  KeeperHub workflow ids: (local — set KEEPERHUB_API_KEY to register)

● Scene 2 — Agent draws 8,500 FXRP
  debt $4420 · HF 1.13 · status MARGIN_CALL · FTSO $0.52

● Scene 3 — Automation fired: guard-hf-1.4
  trigger: health factor 1.13 < 1.4
  action: deleverage 3692.31 FXRP · ok=true
  tx 0xf51254772d74c869… · audit 0x46c501cb9eb911603bc483b6051d7914
  explorer https://coston2-explorer.flare.network/tx/0xf51254772d74c869a0ed53dfdb9fa68ae2fb6659361e8352ad8c960ae23b543b

● Scene 4 — Automation fired: derisk-if-xrp-above-0.40
  trigger: FTSO XRP/USD $0.52 > $0.4; already at/above target HF — no repay needed
  action: deleverage · ok=true

● Scene 5 — Position after automations
  debt $2500 · HF 2.00 · status HEALTHY

● Scene 6 — Second tick (idempotency)
  0 automation(s) evaluated as due, 0 performed a repay — position already safe

● Scene 7 — KeeperHub reliability
  {"total":2,"confirmed":2,"failed":0,"private_routed":2,"sponsored":0,"avg_backoff_attempts":1,"total_gas_used":196800,"by_protocol":{"x402":2}}
```

Reading it end to end:

- **Scene 1 — declare.** The agent commits two rules: `guard-hf-1.4` (`health_below 1.4` →
  deleverage to HF 2.0) and `derisk-if-xrp-above-0.40` (`price_above $0.40` → deleverage to
  HF 2.0). No `KEEPERHUB_API_KEY`, so they are local-only (no workflow ids); with a key each
  would also be a KeeperHub workflow.
- **Scene 2 — trip.** The agent draws 8,500 FXRP. At the FTSO XRP/USD price of $0.52 that
  debt is worth $4,420 against a $5,000 cap → HF 1.13: `MARGIN_CALL`, below the 1.4 guard.
- **Scene 3 — health rule fires.** `guard-hf-1.4` sees `health factor 1.13 < 1.4` and
  deleverages **3,692.31 FXRP** — exactly `debt − cap/2.0 = $4,420 − $2,500 = $1,920` worth,
  priced at $0.52 — through KeeperHub (`ok=true`) with a real tx hash, Blockscout link, and
  audit id.
- **Scene 4 — price rule no-ops.** `derisk-if-xrp-above-0.40` also triggers (FTSO $0.52 >
  $0.40), but the position is already at its 2.0 target after Scene 3, so
  `deleverageToTarget` returns 0 — a satisfied no-op, no repay.
- **Scene 5 — cured.** The debt is $2,500, HF back at exactly **2.00**: `HEALTHY`.
- **Scene 6 — idempotent.** A second tick finds nothing due — the cured position no longer
  trips `health_below`, and the price rule stays a no-op. No on-chain work.
- **Scene 7 — reliability.** Two KeeperHub executions (the draw + the deleverage), both
  confirmed, both private-routed, one gas-backoff attempt each, settled over x402.

---

## Surfaces

The identical engine is exposed on every Cred402 surface.

### MCP tools (`mcp/tools.ts`)

| Tool | Purpose |
|---|---|
| `cred402.create_automation` | Create a set-and-forget rule: `trigger_kind` (`price_below`/`price_above` + `price`, `health_below` + `threshold`, or `schedule` + `every_seconds`) → `action_kind` (`deleverage` + `target_hf`, `repay` + `amount_fxrp`, or `notify`). Registered as a KeeperHub workflow when a real key is set. |
| `cred402.list_automations` | List automations (optionally for one `agent_id`): trigger, action, enabled, fire count, last fired, KeeperHub workflow id. |
| `cred402.tick_automations` | Evaluate every enabled automation against the live FTSO price + position health and EXECUTE the due ones via KeeperHub; returns one run record per fired automation. |
| `cred402.remove_automation` | Delete an automation by `id`. |

### /v1 endpoints (`api/v1/router.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/automations?agent_id=` | List automations (optionally scoped to one agent). |
| `POST` | `/v1/automations` | `{ agent_id, name, trigger, action, cooldown_seconds? }` → create an automation (validated: `trigger.kind`, `price`/`threshold`/`every_seconds`; `action.kind`, `target_hf`/`amount_fxrp`). |
| `POST` | `/v1/automations/tick` | Evaluate + execute all due automations via KeeperHub; returns the runs + current automation list. |
| `POST` | `/v1/automations/:id/toggle` | `{ enabled }` → enable/disable one automation. |
| `POST` | `/v1/automations/:id/remove` | Delete one automation. |

### Console (`api/server.ts` + `api/state.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/automations` | Read-only Automations panel view (`automationsView`): the automation list, the last runs, and the KeeperHub reliability summary — safe to poll. |
| `POST` | `/api/demo/automations` | One-click demo (`runAutomationsDemo`): register the two rules above, draw a risky FXRP position, tick, and return `created` / `draw` / `runs` / `after` / `reliability`. |

The console's **Flare tab → Automations panel** reads `/api/automations` and drives the
demo through `/api/demo/automations`.

### Script

```bash
npm run automations:run     # scripts/automations_run.ts — declare 2 rules → margin call → tick fires → cured → idempotent
```

---

## What's real vs sim

Following the repo's *real-behind-env + deterministic sim* convention — same return shapes
either way, so the demo and tests run with zero keys:

| Capability | Real (env set) | Sim (default) |
|---|---|---|
| Trigger price / health (FTSO) | `FtsoV2.getFeedById` `eth_call` via `FLARE_RPC_URL` | Deterministic reference (`XRP/USD = $0.52`); RPC failure degrades to sim |
| Action execution (the repay) | MCP-over-HTTP to `https://app.keeperhub.com/mcp` with `KEEPERHUB_API_KEY` → real tx hash | Deterministic sim execution + audit trail |
| KeeperHub workflow registration | `create_workflow` (+ `validate_cron` for schedules) → real `keeperhub_workflow_id` | Skipped — automation is local-only, fully functional |

The trigger evaluation, the deleverage math, the cooldown, the idempotency rule, and the
"only ever repay existing debt" safety are **enforced identically** in both modes — only
the price feed, the transaction broadcast, and the workflow registration differ.

## References

- Reactive counterpart (FTSO risk → protective deleverage): [credit_keeper.md](credit_keeper.md)
- Execution layer (workflow + cron + check-and-execute): [keeperhub_integration.md](keeperhub_integration.md)
- Risk pricing (FTSO position health): [flare_integration.md](flare_integration.md)
- Engine: `lib/flare/automations.ts` · Position math: `lib/flare/positions.ts` · Demo:
  `scripts/automations_run.ts`