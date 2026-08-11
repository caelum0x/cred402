# Autonomous Scheduler — the last mile, on a cadence

> **The keeper reacts to a margin call and automations fire on a trigger — but both
> still need something to CALL them on a cadence.** The Autonomous Scheduler is that
> something: a KeeperHub-cron-style loop that runs registered jobs (a keeper fleet
> sweep every 60s, a credit-automation tick every 30s), each on its own interval, so
> the whole system operates unattended — decide → execute → on a schedule, forever.

Cred402's execution story has two halves already. The [Autonomous Credit Keeper](credit_keeper.md)
*checks* every FTSO-priced position and, on a margin call, *executes* a protective
deleverage. [Credit Automations](credit_automations.md) let an agent declare its own
`price`/`health`/`schedule` policy and fire it on a trigger. Both are correct — and both
are inert until something invokes them on a clock. The scheduler closes that last gap: it
is the recurring heartbeat that turns a set of reactive/declarative rules into a system
that runs itself.

This maps directly to KeeperHub's **scheduled-workflow / cron** surface (`create_workflow`
with a cron, `validate_cron`): a Cred402 scheduler job is a local mirror of a KeeperHub
cron trigger, driving the same reliable execution seam every keeper deleverage and
automation already routes through (simulate → smart gas → private routing → audit).

---

## The model

The scheduler (`lib/keeperhub/scheduler.ts`) is built around a **deterministic
`tick(now)` core** — pure and testable. `start()` merely wires a real timer to
`tick(Date.now())`; nothing about the scheduling logic depends on wall-clock timers, so
it is fully reproducible in tests and in the worked example below.

- **The interval rule.** A job is *due* when it has never run (`last_run_at === undefined`)
  **or** enough time has elapsed (`now - last_run_at >= interval_sec`). `tick(now)` runs
  every due, enabled job and returns the runs that executed this tick.
- **The per-job overlap guard.** Each job carries a `running` flag set *before* the
  `await` and cleared in `finally`. A job already running (a slow previous run) is skipped,
  never double-started — a concurrent tick can't double-run the same job.
- **The `JobRun` history.** Every run records `{ job, at, ok, ms, summary?, error? }`,
  capped at the last 100. `status()` returns each job's interval, enabled/running state,
  run count, and `next_due_at` (`last_run_at + interval_sec`), plus the recent run history.
- **DEFAULT OFF.** In the server the scheduler getter builds the two jobs but does **not**
  start a timer — nothing executes autonomously until `start()` is called. On the console
  the demo instead runs a single explicit tick.
- **Stop-on-reset.** A ledger `reset()` calls `this._scheduler?.stop()`, so a fresh
  economy always starts idle — an autonomous loop never survives a reset unnoticed.

The two registered jobs:

| Job | Interval | Runs |
|---|---|---|
| `keeper-sweep` | 60s | `CreditKeeper.runFleet(...)` across every registered agent — protective deleverages via KeeperHub |
| `automation-tick` | 30s | `AutomationEngine.tick(...)` — evaluate every enabled automation against live FTSO + position health, execute the due ones |

---

## Worked example

`npm run scheduler:run` (`scripts/scheduler_run.ts`) drives the deterministic `tick(now)`
core by hand across a simulated timeline (instead of waiting on real timers), so the whole
cadence is demonstrable in a second, with zero keys and zero network:

```text
┌──────────────────────────────────────────────────────────────┐
│ Cred402 Autonomous Scheduler — the last mile, on a cadence │
└──────────────────────────────────────────────────────────────┘

● Scene 1 — Scheduler jobs
  keeper-sweep: every 60s (enabled)
  automation-tick: every 30s (enabled)

● Scene 2 — t=1000 — agent draws 8,500 FXRP (margin call)
  position is now under-collateralized; no human is watching

● Scene 3 — t=1000 — first tick (all jobs due)
  ▶ keeper-sweep: ok=true — evaluated 2, executed 1
  ▶ automation-tick: ok=true — 0 run(s)

● Scene 4 — t=1030 — automation-tick due again (keeper-sweep not yet)
  ▶ automation-tick: ok=true — 0 run(s)

● Scene 5 — t=1070 — both due (position already cured → no-ops)
  ▶ keeper-sweep: ok=true — evaluated 2, executed 0
  ▶ automation-tick: ok=true — 0 run(s)

● Scene 6 — Scheduler status
  keeper-sweep: 2 run(s), next due at t=1130
  automation-tick: 3 run(s), next due at t=1100
```

Reading it end to end:

- **Scene 1 — jobs.** Two jobs registered on their own intervals: `keeper-sweep` @60s,
  `automation-tick` @30s.
- **Scene 2 — risk with no human.** At `t=1000` the agent draws 8,500 FXRP, under-
  collateralizing the position. Nobody is watching — the scheduler is the only thing that
  will act.
- **Scene 3 — first tick (all jobs due).** At `t=1000` neither job has ever run
  (`last_run_at === undefined`), so both are due. `keeper-sweep` sweeps the fleet and
  **executes 1** deleverage (the risky position), curing it; `automation-tick` fires but no
  automation's trigger is due, so 0 runs.
- **Scene 4 — only the 30s job (`t=1030`).** 30s have elapsed, so `automation-tick` is due
  again, but only 30s of the keeper's 60s interval has passed — `keeper-sweep` is skipped by
  the interval rule.
- **Scene 5 — both due, but no-ops (`t=1070`).** Both intervals have elapsed. The keeper
  sweep evaluates all agents but **executes 0** — the position was already cured in Scene 3,
  so there is nothing to deleverage. This is the safety property in action: a sweep of a
  healthy fleet is a no-op.
- **Scene 6 — status.** Run counts (`keeper-sweep` 2, `automation-tick` 3) and each job's
  `next_due_at` (`last_run_at + interval_sec`): the keeper next due at `t=1130`, the
  automation at `t=1100`.

---

## Surfaces

The same scheduler is exposed on every Cred402 surface.

### MCP tools (`mcp/tools.ts`)

| Tool | Purpose |
|---|---|
| `cred402.scheduler_status` | Status of the autonomous scheduler: its jobs (keeper fleet sweep + automation tick), their intervals, whether it is running, and the recent run history. Models KeeperHub's scheduled-workflow/cron surface. |
| `cred402.scheduler_tick` | Run one scheduler tick now: execute any due jobs (protective keeper deleverages across the fleet + due credit automations) through KeeperHub. Returns the runs that fired plus the new status. |

### /v1 endpoints (`api/v1/router.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/scheduler` | Scheduler status: jobs, intervals, started flag, run counts, `next_due_at`, recent runs. |
| `POST` | `/v1/scheduler/tick` | Run one tick now → the runs that fired + status. |
| `POST` | `/v1/scheduler/start` | Start the real timer. Optional `{ interval_ms }` (min 1000; default 15000). |
| `POST` | `/v1/scheduler/stop` | Stop the timer. |

### Console (`api/server.ts`)

| Method | Route | Returns |
|---|---|---|
| `GET` | `/api/scheduler` | Read-only scheduler status — safe to poll for the Flare tab **Scheduler** panel. |
| `POST` | `/api/scheduler/tick` | Run one tick now. |
| `POST` | `/api/scheduler/start` | Start the timer (15s default). |
| `POST` | `/api/scheduler/stop` | Stop the timer. |

The Flare tab's **"Autonomous Scheduler — the last mile, on a cadence"** panel
(`frontend/src/components/Flare.tsx`) polls `/api/scheduler` and offers **run-one-tick**,
**start**, and **stop** controls; the demo path uses a single tick so nothing runs
unattended in the browser.

### Script

```bash
npm run scheduler:run   # scripts/scheduler_run.ts — the deterministic cadence demo above
```

---

## A safety note

The scheduler is **default OFF**: the server builds its two jobs but starts no timer, so
nothing executes autonomously until `start()` (or `POST /v1/scheduler/start`) is called,
and a ledger `reset()` stops it again. The console demo deliberately uses a **single tick**
rather than a running timer.

This matters because the scheduler executes **real protective actions** — a `keeper-sweep`
deleverages margin-called positions through KeeperHub. It inherits the keeper's safety
property (it can only ever repay FXRP an agent already drew, so the worst case of an
unattended run is a no-op, never new leverage), but running it on a live timer means the
system acts on your fleet without a human in the loop. It is opt-in by design.

---

## What's real vs sim

Following the repo's *real-behind-env + deterministic sim* convention:

- **Real + deterministic (always):** the `tick(now)` scheduling logic — the interval rule,
  the per-job overlap guard, the due-job selection, and the run history — is real code with
  no environment dependency. The demo drives it on a simulated clock precisely because the
  core is deterministic.
- **Real-behind-env + sim (as elsewhere):** the *work* each job performs —
  `CreditKeeper.runFleet(...)` and `AutomationEngine.tick(...)` — routes through the same
  FTSO price feed and KeeperHub execution seam as everything else, real behind
  `FLARE_RPC_URL` / `KEEPERHUB_API_KEY` and a deterministic sim otherwise. See
  [keeperhub_integration.md](keeperhub_integration.md) and [credit_keeper.md](credit_keeper.md).

---

## References

- Execution seam (cron surface): [keeperhub_integration.md](keeperhub_integration.md)
- Reactive keeper the sweep runs: [credit_keeper.md](credit_keeper.md)
- Declarative policies the tick evaluates: [credit_automations.md](credit_automations.md)
- Scheduler: `lib/keeperhub/scheduler.ts` · Demo: `scripts/scheduler_run.ts` · Tests:
  `test/scheduler.test.ts`
