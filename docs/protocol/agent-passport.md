# Agent Passport & Reputation Engine (p2 §6.2, §6.6)

## Agent Passport (Product A)

The passport is the **read-optimized public profile** other protocols and the MCP
server integrate against. The `AgentRegistry` is the canonical source of truth;
the passport aggregates a derived view:

```
agent_id · service_type · operator · stake
reputation_score · credit_score · credit_limit · outstanding_debt
total_receipts · total_revenue · dispute_rate
capabilities · spending_limit · last_active_at · risk_flags
```

Risk flags are computed live: `elevated_dispute_rate`, `open_dispute`,
`credit_frozen`, `defaulted`, `no_stake`.

Read it via:

```
GET  /api/passport/:agent_id
MCP  cred402.get_agent_passport
URI  cred402://agents/{agent_id}
```

Implementation: `lib/ledger/contracts/agent_passport.ts`, surfaced in the
dashboard **Agents** tab (capabilities + risk-flag chips).

## Reputation Engine (§6.6)

Reputation is multi-dimensional, computed in `lib/ledger/contracts/reputation_engine.ts`:

```
quality_score          accuracy of submitted evidence
timeliness_score       responsiveness / throughput
dispute_score          inverse of dispute rate
revenue_score          x402 receipt volume
repayment_score        on-time repayment ratio
category_expertise     jobs completed in the service category
collusion_penalty      subtracted for open disputes
```

```
reputation = 0.30·quality + 0.10·timeliness + 0.20·dispute
           + 0.15·revenue + 0.15·repayment + 0.10·expertise
           − collusion_penalty            (clamped 0..100)
```

The composite score is written back on-chain via
`AgentRegistry.update_reputation`, shown as the **"ReputationEngine recomputes
trust"** scene in the demo.
