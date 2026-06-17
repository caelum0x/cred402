# Risk model

The `RiskPolicyManager` underwrites agents from their on-chain track record. It is
an **upgradable** contract: the policy can evolve from `v1` to `v2` without
redeploying the pool or registries — a core reason Cred402 lives on Casper.

## The formula (v1)

```
base_limit         = 0.30 * last_30_day_x402_revenue
stake_multiplier   = min(2.0, 1 + stake_CSPR / 100)
dispute_penalty    = max(0.2, 1 - dispute_rate * 5)
accuracy_multiplier= accuracy_score / 100

credit_line = base_limit * stake_multiplier * dispute_penalty * accuracy_multiplier
```

Worked example (the demo seller):

```
30-day revenue : ~127 CSPR
stake          : 50 CSPR   -> stake_multiplier   = min(2.0, 1 + 0.5)   = 1.50
dispute_rate   : 1.7%      -> dispute_penalty     = max(0.2, 1 - 0.085) = 0.915
accuracy       : 90/100    -> accuracy_multiplier = 0.90
base_limit     : 38.1 CSPR
credit_line    : 38.1 * 1.50 * 0.915 * 0.90 ≈ 47 CSPR
```

Credit score (0..100) blends accuracy, reputation and (100 − dispute%). Interest is
inversely mapped from score: ~8% APR for a top agent, ~22% APR for a weak one.

## Service-category weighting (roadmap p1) — credit for the whole x402 economy

Cred402 underwrites **any** x402 service, not just RWA. Every credit line is scaled
by a `category_multiplier` from the agent's service category:

```
credit_line *= category_multiplier        # categoryRiskMultiplier(service_type)
```

The weight comes from the `ServiceCategoryRegistry`
(`lib/core/service_categories.ts` + the on-chain mirror), governance-tunable per
category family:

```
rwa 1.00 · compliance 0.95 · data/api 0.90 · compute/storage 0.85 ·
inference/dispute 0.80 · defi 0.75 · unknown 0.65 (conservative default)
```

So a non-RWA agent (e.g. `inference.llm`) builds a credit line from its x402
receipts alone — no RWA evidence required — just weighted for its category's risk.
Run `npm run demo:x402` to see it. RWA evidence remains an optional *boost* for RWA
categories, not a gate.

## The upgrade (v2)

`v2` demonstrates a hot-swappable policy that:

- raises the base draw to `0.35 * revenue`,
- softens the stake reward but **doubles down** on disputes (`× 8` not `× 5`),
- adds a **throughput bonus** (`min(1.25, 1 + jobs/1000)`) that rewards proven
  machine-service volume.

The demo (`npm run demo`) prints the same agent's line under v1 and v2 to show the
policy changing on-chain via `RiskPolicyManager.upgrade("v2")`, while the pool and
registries keep running untouched.

## RWA job scoring (loan-to-value)

Separately, the `CreditAgent` scores each RWA job from its **verified** evidence:

```
avg_confidence = mean(verified evidence confidence)        # 0..100
recommended_LTV = min(0.70, (avg_confidence / 100) * 0.72)
approved = (all needed evidence verified) AND (LTV >= 0.40)
approved_amount = min(requested_loan, requested_loan * LTV)
```

This is the number the `TreasuryAgent` acts on when financing the asset.

## Why credit at all?

Autonomous agents must pay for satellite imagery, weather/IoT data, KYC checks, LLM
inference and transaction fees **before** the protocol that hired them pays out.
Cred402 finances that gap against verified machine-to-machine cash flow — a new DeFi
category: agent receivable factoring / machine-service cash-flow lending.
