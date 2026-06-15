# Demo script

Run `npm run demo` (terminal) or click **Run full loop** in the dashboard. Six
scenes, ~90 seconds.

## Scene 1 — An RWA needs evidence

`RWARequestAgent` posts job **SOLAR-A17** (Solar Farm SPV #A17, Izmir): requested
loan 5,000 CSPR test units, needed evidence = energy output, weather risk,
receivable quality. A `RwaJobCreated` event hits the chain.

## Scene 2 — An autonomous agent buys data

For each evidence type, `EvidenceSellerAgent` returns `402 Payment Required`.
`RWARequestAgent` signs a payment authorization and pays 0.002 CSPR over x402. Show
the headers, signature and receipt hash.

## Scene 3 — Agent submits RWA evidence

```
Energy output: 84,200 kWh
Weather anomaly risk: Low
Receivable confidence: 88/100
Recommended max LTV: 64%
Evidence hash: 0x…
Receipt hash:  0x…
```

Evidence hashes and receipts are committed to Casper.

## Scene 4 — Agent earns reputation

Receipts finalize, evidence is verified, and the seller's reputation ticks up
(91 → 93+). 30-day revenue and dispute rate update.

## Scene 5 — Agent receives a DeFi credit line

`CreditAgent` runs the policy: strong x402 revenue + low dispute rate + staked
collateral + high accuracy → **credit score 94/100**, ~8.8% APR, **~47 CSPR** line.
`AgentCreditPool` opens the line.

## Scene 6 — Agent draws working capital

The seller draws 6 CSPR (for future data purchases), due in 7 days, then repays —
interest compounds into LP yield. The audience sees the full flywheel:

```
Agent works → gets paid → proves reliability → gets credit → performs more RWA work
```

## Bonus — Upgradable policy

The script swaps `RiskPolicyManager` v1 → v2 live and re-underwrites the same agent,
showing the credit line change without redeploying the pool.

## Stretch — Dispute & slashing (`npm run demo:dispute`)

1. `EvidenceSellerAgent` submits falsified energy output (138,000 kWh).
2. `WatchdogAgent` cross-checks against an independent reading (84,200 kWh) — 64% deviation.
3. It opens a dispute, slashes 10 CSPR of stake, freezes the credit line, drops reputation −25.
4. The receipt is marked `disputed`; the credit path halts.

## Video structure (3 min)

| Time      | Beat |
| --------- | ---- |
| 0:00–0:20 | Hook — "economic actors need credit; Cred402 is the first credit layer for agents servicing RWAs on Casper." |
| 0:20–0:50 | Problem — agents must pay for data/compute/fees before they get paid; no credit history today. |
| 0:50–1:40 | Live flow — job → 402 → pay → evidence → receipt on Casper. |
| 1:40–2:20 | DeFi credit — revenue history → score → line → draw. |
| 2:20–2:50 | Accountability — watchdog event → dispute/slash. |
| 2:50–3:00 | Close — "Casper is the trust layer for the agent economy. Cred402 turns that trust into credit." |
