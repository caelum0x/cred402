# Cred402 protocol thesis

> **Cred402 turns x402 machine-to-machine revenue into on-chain agent credit.
> Agents earn by verifying RWAs, prove their work through Casper receipts, build
> reputation, and borrow from DeFi liquidity pools to finance future autonomous
> work.**

## The shift

The old world: APIs sell data to humans; DeFi accepts human wallets; RWA
protocols rely on off-chain operators; credit bureaus track human repayment.

The new world: autonomous agents become economic actors. They buy data, sell
analysis, verify collateral, monitor repayment, file disputes, settle invoices,
purchase compute, pay APIs, earn fees — and need working capital before they get
paid.

To participate they need: **identity, payment rails, receipt history, reputation,
credit lines, slashing, disputes, risk scoring, auditable evidence.**

## Cred402 = the missing financial layer

```
x402 payments      → machine-native revenue
Casper identity    → agent identity (account abstraction)
Receipts           → proof of work and income
RWA evidence       → proof of useful economic work
Reputation         → agent trust score
Credit pool        → DeFi working capital
Disputes/slashing  → accountability
MCP tools          → autonomous execution surface
```

## Why Casper

Casper's AI Toolkit positions the chain as machine-commerce infrastructure:
account abstraction for agent identity, **upgradable contracts** (so credit
policy can evolve — `RiskPolicyManager` v1→v2), predictable fees (so agents can
budget autonomous spend — the very reason credit is needed), **x402
micropayments**, **MCP access**, **streaming events** (the WatchdogAgent's
nervous system), CSPR.cloud, Odra, and casper-eip-712 (domain-separated payment
authorizations).

## The flywheel

```
Agent works → gets paid (x402) → proves reliability (receipts + evidence)
   → builds reputation → gets a credit line → finances more RWA work
   → more agents join because they can earn, borrow, and build reputation.
```

## A new DeFi category

Not human lending. **Agent receivable factoring / machine-service cash-flow
lending**: the pool finances productive agent work against verified x402 cash
flow, priced by reputation and accuracy, with slashing for misbehavior.

This is infrastructure, not an app: the financial operating system for agents
that work on RWAs.
