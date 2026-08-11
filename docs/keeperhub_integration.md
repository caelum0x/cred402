# Cred402 × KeeperHub — The Last Mile

> **Agents decide; KeeperHub executes.** Cred402 is the decision layer — who is
> creditworthy, how much to draw, when to repay. KeeperHub is the execution layer —
> it takes a decided transaction and lands it on-chain with reliability guarantees
> (preflight simulation, smart gas with exponential backoff, MEV-protected private
> routing, an audit trail, and pay-per-execution over x402 / MPP).

Cred402 spends most of its code deciding creditworthiness: verifiable x402 revenue,
reputation, risk policy, a Casper-signed Credit Authorization Note (CAN), and a shared
global-exposure cap. None of that matters if the resulting on-chain transaction gets
stuck in the mempool, gets sandwiched, or silently fails. KeeperHub is the last mile:
the seam between *"the agent decided to draw 500 FXRP"* and *"here is the confirmed
transaction hash, priced, routed, and audited."*

## Where KeeperHub sits

KeeperHub is injected as an `OnchainExecutor` into a satellite adapter. The adapter
decides the credit action against Casper policy; it hands the actual submission to
KeeperHub and keeps the returned execution id, audit id, and tx hash.

```text
  Casper root ── issues + ed25519-signs a CAN (USD limit, global-exposure checked)
       │
       ▼
  FlareAdapter / EVM adapter ── DECIDES the draw, prices it via FTSO
       │  intent: { kind: "credit_draw", chain_id, to: vault, function, args, … }
       ▼
  KeeperHubExecutor (OnchainExecutor) ── THE LAST MILE
       │  x402/MPP pay-per-execution → simulate (preflight) → smart gas w/ backoff
       │  → private / MEV-protected submit → poll to a tx hash → audit trail
       ▼
  on-chain (Coston2 / Flare / Base / …) ── confirmed tx hash + gas used
```

The contract is the `OnchainExecutor` interface — anything that satisfies it (the real
KeeperHub executor or the deterministic sim) can be dropped into an adapter:

```typescript
// lib/keeperhub/types.ts
export interface OnchainExecutor {
  execute(intent: ExecutionIntent): Promise<ExecutionResult>;
  auditTrail(): AuditRecord[];
  isLive(): boolean;
}
```

`FlareAdapter` takes it as a constructor option and calls it only after the vault has
validated and FTSO-priced the draw:

```typescript
// packages/chain-adapters/src/adapters/flare/FlareAdapter.ts
if (this.opts.executor) {
  const exec = await this.opts.executor.execute({
    kind: "credit_draw",
    chain_id: this.network.keeperhubChainId,          // "114" (Coston2)
    to: this.vault.poolAddress,
    function: "executeDraw(bytes32,address,uint256)",
    args: [draw.note_id, draw.agent_id, input.amount],
    agent_id: draw.agent_id,
    label: `cred402 FXRP draw ${draw.agent_id}`,
    metadata: { note_id: draw.note_id, usd_6dp: draw.usd_6dp.toString(), xrp_usd: draw.xrp_usd },
  });
  if (!exec.ok) return { ok: false, tx_hash: "", detail: `keeperhub: ${exec.detail ?? "execution failed"}` };
  tx_hash = exec.tx_hash;
}
```

KeeperHub never has custody and never has discretion: it can only submit a transaction
that a valid CAN already authorized. It retries on transient failure and relays the
outcome back to the Casper root.

## The execution pipeline

`KeeperHubExecutor.execute()` runs one intent through the full reliability envelope
(`lib/keeperhub/executor.ts`):

1. **Pay-per-execution (x402 / MPP).** `PaymentRouter.settle()` selects the rail and
   produces a receipt *before* submission — the execution is paid for like any x402
   resource.
2. **Preflight simulation.** On the live path this calls KeeperHub's
   `execute_contract_call` with `simulate: true`; a revert reason short-circuits the
   whole execution and is recorded as `failed` — nothing is broadcast.
3. **Smart gas with exponential backoff.** `SmartGasEstimator` prices EIP-1559 fees off
   the simulation's gas estimate and, on congestion / cold-start retries, multiplies the
   fee cap by `backoffFactor^attempt` so a stuck transaction is *replaced* by one the
   network will include instead of stalling.
4. **MEV-protected private routing.** The live submit passes `private: true` (default;
   `KEEPERHUB_PRIVATE_ROUTING=0` disables), so the transaction is routed privately rather
   than exposed in the public mempool.
5. **Poll to a tx hash.** `get_direct_execution_status` is polled until `confirmed` /
   `success` (returns the tx hash + gas used) or `failed` / `reverted`. KeeperHub's
   `upstream_cold_start` hint is honored by sleeping `retryAfterSeconds` and retrying
   with the **same idempotency key**, so a cold upstream never double-submits.
6. **Audit trail.** Every step — trigger, simulation, gas policy, payment rail, private
   routing, outcome, gas used, timestamps — is appended immutably to the `AuditTrail`.

The sim path (no key) produces the exact same `ExecutionResult` shape deterministically,
so the whole loop is demonstrable with zero keys and zero network.

## The KeeperHub surface, mapped to files

KeeperHub is a Streamable-HTTP MCP server at `https://app.keeperhub.com/mcp`, authed with
`Authorization: Bearer kh_<key>`. Cred402 models the surface faithfully, one concern per
file:

| KeeperHub surface | Cred402 file | What it does |
|---|---|---|
| MCP server (`execute_contract_call`, `execute_transfer`, `get_direct_execution_status`) | `lib/keeperhub/client.ts` | Thin MCP-over-HTTP client; dynamically imports `@modelcontextprotocol/sdk`, connects via `StreamableHTTPClientTransport`, sends `Bearer kh_<key>`. Live only when `KEEPERHUB_API_KEY` is set. |
| x402 / MPP pay-per-execution + gas sponsorship | `lib/keeperhub/payments.ts` | `PaymentRouter` picks x402 (Base USDC, EIP-3009 `TransferWithAuthorization`, indexed on x402scan.com), MPP (Tempo USDC.e facilitator), or `sponsored` (mainnet Ethereum gas sponsorship → agent pays nothing). |
| Smart gas estimation | `lib/keeperhub/gas.ts` | `SmartGasEstimator`: EIP-1559 pricing with `eip1559-exponential-backoff` fee bumps + retry delay schedule. |
| Preflight simulation + private routing + poll | `lib/keeperhub/executor.ts` | `KeeperHubExecutor`: `simulate:true` preflight, private submit, cold-start-aware polling, idempotency key. |
| Audit trail / observability | `lib/keeperhub/audit.ts` | `AuditTrail`: append-only records + a reliability `summary()` (confirmed, private-routed, sponsored, avg backoff, gas, protocol breakdown). |
| Types / executor seam | `lib/keeperhub/types.ts` | `OnchainExecutor`, `ExecutionIntent`, `ExecutionResult`, `AuditRecord`. |
| Barrel export | `lib/keeperhub/index.ts` | Public API. |

## How to run

```bash
# Deterministic sim (no key) — full pipeline, no network:
npm run keeperhub:execute -- \
  --chain 114 --to 0xYourVault --fn "executeDraw(bytes32,address,uint256)"

# Real execution against KeeperHub's MCP server (returns a real tx hash):
export KEEPERHUB_API_KEY=kh_your_org_key
npm run keeperhub:execute -- \
  --chain 114 --to 0xYourVault --fn "executeDraw(bytes32,address,uint256)"
```

`scripts/keeperhub_execute.ts` prints the intent, the execution result (source
`sim` vs `keeperhub`, tx hash, simulation, gas policy + backoff, payment rail, private
routing), and the reliability rollup. `executor.isLive()` tells you which path ran.

### Environment

| Var | Default | Meaning |
|---|---|---|
| `KEEPERHUB_API_KEY` | *(unset → sim)* | Org API key (`kh_…`). Presence flips sim → real execution. |
| `KEEPERHUB_API_URL` | `https://app.keeperhub.com/mcp` | MCP server endpoint. |
| `KEEPERHUB_PRIVATE_ROUTING` | `1` | MEV-protected private submission. `0` submits publicly. |
| `KEEPERHUB_GAS_SPONSORSHIP` | `0` | On mainnet Ethereum (chain `1`), sponsor gas → agent pays nothing. |
| `KEEPERHUB_MPP_ONLY` | `0` | Force MPP (Tempo USDC.e) instead of the default x402 (Base USDC). |

### /v1 endpoints

KeeperHub execution is observable through the production `/v1` API (`api/v1/router.ts`):

| Method | Route | Returns |
|---|---|---|
| `GET` | `/v1/keeperhub/reliability` | Reliability summary: executions, confirmations, private-routed + sponsored counts, avg gas-backoff attempts, total gas, x402/MPP breakdown. |
| `GET` | `/v1/keeperhub/audit?agent_id=…` | Full per-execution audit trail (optionally scoped to one agent). |

Draws that route through KeeperHub land via `POST /v1/flare/draw` and `POST /v1/flare/repay`.

### MCP tools

| Tool | Purpose |
|---|---|
| `cred402.keeperhub_reliability` | Session reliability summary (as above). |
| `cred402.keeperhub_audit` | Audit trail: trigger → simulation → submit → gas → payment → outcome, optionally filtered by agent. |

## Judging-criteria mapping

| Criterion | Where it is satisfied |
|---|---|
| **Executes on-chain via KeeperHub** | `KeeperHubExecutor.submitLive()` drives `execute_contract_call` + `get_direct_execution_status` over the MCP server; `FlareAdapter.drawCredit()` / `repayCredit()` inject it as the `OnchainExecutor`. |
| **Use of KeeperHub surfaces** | MCP server (`client.ts`), x402/MPP + gas sponsorship (`payments.ts`), smart gas (`gas.ts`), simulation + private routing (`executor.ts`), audit trail (`audit.ts`). |
| **Reliability & observability** | Preflight `simulate:true`, exponential-backoff gas, `upstream_cold_start` retry with reused idempotency key, append-only `AuditTrail` + `summary()`, surfaced at `/v1/keeperhub/*` and `cred402.keeperhub_*`. |
| **Originality** | KeeperHub is used as the credit-protocol *execution seam*: agents make the credit decision, KeeperHub is the only thing allowed to move value on-chain — and only for a CAN that already authorized it. |
| **Integration quality** | One `OnchainExecutor` interface serves every EVM satellite; identical `ExecutionResult` shape across sim and real; env-driven; no key required to demo. |

## What's real vs sim

Following the repo's convention of *real-behind-env + deterministic sim*:

- **Real (with `KEEPERHUB_API_KEY`):** MCP-over-HTTP calls to
  `https://app.keeperhub.com/mcp`, `Bearer kh_<key>`, `execute_contract_call`
  (`simulate:true` then broadcast) and `get_direct_execution_status`, `upstream_cold_start`
  retry with a reused idempotency key, private routing flag — returning a real tx hash.
- **Sim (no key):** deterministic simulation, gas math, payment receipts, tx hashes, and
  audit records — the exact same `ExecutionResult` shape, so tests and the demo run with
  no key and no network.
- **Modeled honestly (server-side in KeeperHub either way):** actual x402 / MPP settlement
  and the smart-gas engine live inside KeeperHub's agentic wallet. `payments.ts` and
  `gas.ts` mirror that behavior locally so the receipt and gas policy are visible in the
  audit trail; they do not themselves move funds.

## Autonomous Credit Keeper (check → execute)

The flagship use of KeeperHub's **execute-check-and-execute** pattern in Cred402 is the
Autonomous Credit Keeper. Every agent's FXRP debt carries live FTSO price risk: because the
debt is drawn in a volatile asset but capped in USD, the live FTSO XRP/USD price
continuously re-marks it into a health factor. The keeper *checks* that condition on-chain
and, when it breaches the margin-call line, *executes* a protective deleverage on-chain —
condition → action, exactly the pattern KeeperHub exists to run reliably.

```text
  CreditKeeper.check   →  PositionEngine marks FXRP debt to FTSO, HF < 1.15 = margin call
        │
        ▼
  CreditKeeper.execute →  repay(agent, amount) through KeeperHub
        │  simulate (preflight) → smart gas w/ backoff → private routing → poll → audit
        ▼
  confirmed tx hash + Blockscout link + audit id   (rollback-on-failure: a revert
                                                     short-circuits before broadcast)
```

This is the same execution seam as the FXRP draw — but triggered by a *condition* rather
than an agent request, run unattended, and inherently safe: the keeper can only ever repay
FXRP the agent already drew, so the worst case of an autonomous run is a no-op, never new
leverage. Preflight `simulate:true` means a failing protective action is recorded as
`failed` and never half-applies; the cold-start retry reuses the same idempotency key so a
protective repay is never double-submitted. Every action lands in the same append-only
`AuditTrail` surfaced at `/v1/keeperhub/*` and `cred402.keeperhub_*`.

Surfaces: `cred402.keeper_evaluate` · `cred402.keeper_run` · `cred402.keeper_run_fleet`
(MCP); `GET /v1/keeper/evaluate/:id`, `POST /v1/keeper/run`, `POST /v1/keeper/run-fleet`
(REST); `npm run keeper:run`. Full write-up, including the FTSO health-factor model and a
worked margin-call → deleverage → stress-test example: [credit_keeper.md](credit_keeper.md).

## Credit Automations (workflow + cron)

Where the Autonomous Credit Keeper uses KeeperHub's **check-and-execute** pattern reactively,
**Credit Automations** are the direct use of KeeperHub's **workflow-builder + cron** surface:
an agent declares its OWN policy up front — a `price_below`/`price_above` (FTSO XRP/USD),
`health_below` (FTSO-priced health factor), or `schedule` trigger → a `deleverage`/`repay`/
`notify` action — and KeeperHub runs it on a schedule or on a trigger.

When `KEEPERHUB_API_KEY` is set, each automation is registered as a KeeperHub workflow via
`create_workflow` (with a `validate_cron`-checked cron for `schedule` triggers), created
`enabled: false` so it is driven by Cred402's `tick` until you enable it on KeeperHub to
schedule. Every fired action still runs through the same reliability envelope documented
above — preflight `simulate:true` → smart gas with backoff → private routing → poll → the
same append-only `AuditTrail` at `/v1/keeperhub/*` and `cred402.keeperhub_*`.

Surfaces: `cred402.create_automation` · `cred402.list_automations` ·
`cred402.tick_automations` · `cred402.remove_automation` (MCP); `GET/POST /v1/automations`,
`POST /v1/automations/tick`, `POST /v1/automations/:id/toggle`,
`POST /v1/automations/:id/remove` (REST); `npm run automations:run`. Full write-up, model,
and a worked declare → tick → cured → idempotent example: [credit_automations.md](credit_automations.md).

## Credit-Service Marketplace (x402 call_workflow shape)

The relationship runs both ways. Where KeeperHub sells *execution* per call, Cred402
sells its *credit intelligence* per call — over x402, in the exact same pay-per-call
shape as KeeperHub's marketplace `call_workflow`: a paid listing whose first call
returns an HTTP `402 Payment Required` challenge, which the caller signs and retries
to settle. Cred402's catalog (credit checks, TEE-attested confidential scores, FTSO
position health, ML risk scores, underwriting) is served at `/x402/services/:id`
behind the real `X402Gateway`, and every settled call is anchored as Cred402's own
x402 revenue — the same revenue → reputation loop KeeperHub's paid executions feed.

Full write-up, catalog, surfaces, and a worked `402 → sign → 200 → replay-rejected`
example: [x402_marketplace.md](x402_marketplace.md).

## Autonomous Scheduler (cron)

The keeper and Credit Automations both decide *what* to do; neither runs itself. The
**Autonomous Scheduler** is the direct use of KeeperHub's **scheduled-workflow / cron**
surface (`create_workflow` with a cron, `validate_cron`) applied to exactly those two: a
cron-style loop that runs a `keeper-sweep` job (fleet-wide protective deleverages) every
60s and an `automation-tick` job (evaluate + fire due automations) every 30s, each on its
own interval. Every action a job fires still lands through the same reliability envelope
documented above — preflight `simulate:true` → smart gas with backoff → private routing →
poll → the same append-only `AuditTrail` at `/v1/keeperhub/*` and `cred402.keeperhub_*`.

The core is a deterministic `tick(now)` with a per-job overlap guard, so a slow run is
never double-started; `start()` just wires a real timer to it. It is **default OFF** —
nothing executes autonomously until started, and a ledger reset stops it — because a
running sweep executes real protective deleverages unattended.

Surfaces: `cred402.scheduler_status` · `cred402.scheduler_tick` (MCP);
`GET /v1/scheduler`, `POST /v1/scheduler/tick|start|stop` (REST); the Flare tab Scheduler
panel + `/api/scheduler` (console); `npm run scheduler:run`. Full write-up, model, and a
worked cadence example: [scheduler.md](scheduler.md).

## References

- KeeperHub MCP server: <https://app.keeperhub.com/mcp> · docs <https://docs.keeperhub.com/ai-tools/mcp-server>
- KeeperHub agentic wallet (x402 / MPP): <https://docs.keeperhub.com/ai-tools/agentic-wallet>
- Flare satellite that injects the executor: [flare_integration.md](flare_integration.md)
