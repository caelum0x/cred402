# Cred402 Architecture

Cred402 has three layers stacked on Casper's trust primitives.

```
┌─────────────────────────────────────────────────────────────┐
│  Dashboard (React)   Agents tab · RWA Jobs · Receipts · Pool │
└───────────────▲──────────────────────────────┬──────────────┘
        REST + SSE                       POST /api/demo/run
                │                                │
┌───────────────┴────────────────────────────────▼────────────┐
│  API server (node:http)  REST · SSE event stream · x402      │
│                          /verify/:type  (402 → proof → 200)  │
└───────────────▲──────────────────────────────┬──────────────┘
                │ calls                          │ subscribes
┌───────────────┴────────────────────────────────▼────────────┐
│  Agent runtime (TypeScript)                                  │
│   BuyerAgent  EvidenceSellerAgent  CreditAgent               │
│   TreasuryAgent  WatchdogAgent      (agents/economy.ts)      │
└───────────────▲──────────────────────────────┬──────────────┘
                │ contract calls                 │ events
┌───────────────┴────────────────────────────────▼────────────┐
│  Casper contract layer                                       │
│   AgentRegistry · X402ReceiptRegistry · RWAEvidenceRegistry  │
│   AgentCreditPool · RiskPolicyManager                        │
│   (Odra/Rust in contracts/ ; simulated in lib/ledger/)       │
└──────────────────────────────────────────────────────────────┘
```

## Layer 1 — Agent identity

Each agent is an `BaseAgent` with its own ed25519 keypair (Casper account
abstraction). On construction it self-registers in `AgentRegistry` with its
public key and service type. Stake is held by the registry and is slashable.

State per agent: `agent_id, public keys, service_type, stake, total_jobs,
revenue history, accuracy_score, dispute_rate, reputation_score, credit_score`.

## Layer 2 — x402 revenue & receipts

`EvidenceSellerAgent` runs paid endpoints. A request without payment returns
`402 Payment Required` + a signed `PaymentChallenge`. The buyer signs a
domain-separated `PaymentAuthorization` (casper-eip-712 style) and retries with an
`X-Payment` header. The seller verifies the ed25519 signature, delivers a signed
report, and commits a `Receipt` (with `payment_proof_hash`, `result_hash`,
`rwa_reference_hash`) to `X402ReceiptRegistry`. Evidence hashes go to
`RWAEvidenceRegistry`, linked to the receipt. See [x402_flow.md](x402_flow.md).

## Layer 3 — DeFi credit

`CreditAgent` reads an agent's 30-day x402 revenue and accuracy/dispute metrics,
runs the active `RiskPolicyManager` policy, writes a credit score on-chain, and
opens a revolving `CreditLine` in `AgentCreditPool`. `TreasuryAgent` seeds pool
liquidity and funds draws; agents repay principal + interest, and interest
compounds into LP yield. See [risk_model.md](risk_model.md).

## Cross-cutting — events & accountability

Every contract mutation emits a `ChainEvent` (Casper streaming-events analogue) on
a shared `EventBus`. The API re-broadcasts these over SSE to the dashboard, and the
`WatchdogAgent` subscribes to them to react in real time: cross-checking evidence
against an independent data source, detecting overdue repayments, opening disputes,
slashing stake, freezing credit and downgrading reputation.

## Determinism & reset

The API holds one persistent `EventBus` + `Clock` so live SSE subscribers survive a
`reset`. `reset` rebuilds the ledger (fresh registries/pool) while keeping the bus
attached, so the dashboard reconnects seamlessly between demo runs.

## Contract ↔ simulation parity

| Odra contract (`contracts/`)    | Simulation (`lib/ledger/contracts/`) |
| ------------------------------- | ------------------------------------ |
| `agent_registry`                | `agent_registry.ts`                  |
| `x402_receipt_registry`         | `x402_receipt_registry.ts`           |
| `rwa_evidence_registry`         | `rwa_evidence_registry.ts`           |
| `agent_credit_pool`             | `agent_credit_pool.ts`               |
| `risk_policy_manager`           | `risk_policy_manager.ts`             |

Method names, state shapes and emitted events match, so moving from simulation to
live Testnet is a transport swap, not a redesign.
