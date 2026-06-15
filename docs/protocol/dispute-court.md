# DisputeCourt, SlashingVault & accountability (p2 §6.9–6.10)

Cred402 is not optimistic. Bad actors are caught and penalized through an
on-chain dispute + slashing pipeline driven by Casper streaming events.

## Contracts

- **DisputeCourt** (`contracts/dispute_court`, `lib/ledger/contracts/dispute_court.ts`)
- **SlashingVault** (`contracts/slashing_vault`, `lib/ledger/contracts/slashing_vault.ts`)

## Dispute types

```
bad_evidence · fake_receipt · non_delivery · payment_reversal
agent_default · collusion · oracle_manipulation · metadata_fraud
```

## Lifecycle

```
opened → evidence_period → under_review → verdict_pending → resolved → closed
```

Verdicts: `agent_wins · agent_loses · partial_fault · inconclusive · malicious_dispute`.

## The flow (who does what)

1. **WatchdogAgent** subscribes to streaming events and cross-checks energy
   evidence against an independent source. On a material deviation it **opens a
   DisputeCourt case** (`bad_evidence`) and disputes the underlying receipt.
2. **DisputeJudgeAgent** investigates: it summarizes the evidence, compares the
   claimed reading vs. the independent source, and returns an **explainable
   recommendation** (verdict + slash amount + rationale). It has *no* unilateral
   authority — it only advises.
3. **DisputeCourt** issues the verdict on-chain (admin/governance-gated).
4. If `agent_loses`/`partial_fault`: the stake is slashed from the `AgentRegistry`
   into the **SlashingVault**, the credit line is **frozen**, and reputation drops
   (−25 / −10).

```bash
npm run demo:dispute          # watch the whole pipeline in the terminal
# or click "⚠ Dispute & slash" in the dashboard → Disputes tab
```

## Slash distribution

The vault splits each slash across destinations (default 50/30/20):

```
victim_reimbursement   50%
insurance_reserve      30%
protocol_treasury      20%
burn                    0%   (governance can enable)
```

Defaults use a 70/30 insurance/treasury split. Every slash is an auditable
`SlashRecord` and the reserve balances are exposed at `GET /api/slashing`.

## Default handling

`WatchdogAgent.monitorRepayments()` opens an `agent_default` dispute for any
overdue credit line, the judge confirms, the pool liquidates the position, the
stake is slashed into the insurance reserve, and reputation drops −40.
