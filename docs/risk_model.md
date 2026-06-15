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
