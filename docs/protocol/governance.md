# Governance (p2 §6.11)

The `Governance` contract (`contracts/governance`,
`lib/ledger/contracts/governance.ts`) controls protocol parameters, fees and
emergency pause flags, with a public, append-only parameter history.

## Parameters

```
protocol_fee_bps              fee on interest routed to the protocol
origination_fee_bps           fee on opening a credit line
min_reputation_to_draw        underwriting floor (default 40)
max_agent_exposure            per-agent credit cap (default 500 CSPR)
dispute_window_seconds        receipt finalization window
paused_credit_draws           emergency pause
paused_registrations          emergency pause
paused_receipt_finalization   emergency pause
```

## Enforced invariants

These parameters are not cosmetic — they gate real actions:

- **`min_reputation_to_draw`** — `CreditAgent.underwrite` refuses any agent below
  the floor.
- **`max_agent_exposure`** — credit lines are capped to this exposure.
- **`origination_fee_bps`** — applied to every opened line.
- **`paused_credit_draws`** — `TreasuryAgent.fundDraw` rejects draws while paused.
- **open dispute** — an agent with an open dispute cannot be underwritten or draw.

## Controls

```
GET  /api/governance                     # params + history
POST /api/governance/param  {key,value}
POST /api/governance/pause  {area,on}
```

The dashboard **Governance** tab exposes emergency pause toggles, parameter
bumps, and the full parameter-change history. Each change emits a
`GovernanceParameterUpdated` / `ProtocolPaused` event.

## Guardrails (production)

In production these actions sit behind a timelock for normal changes, an
emergency-pause path for critical threats, and a launch-phase multisig that
transitions to DAO governance — see `ROADMAP.md`.
