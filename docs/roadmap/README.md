# Cred402 roadmap — the credit layer for the x402 economy

> **Cred402 is the credit & reputation protocol for autonomous agents — for the
> whole x402 economy, not just RWA.** Every x402 payment is a verifiable
> machine-to-machine cash-flow event. Cred402 turns x402 receipts for *any* paid
> agent service — data, compute, inference, storage, APIs, RWA verification,
> anything — into on-chain reputation and DeFi credit, rooted on Casper.

RWA verification (the solar-farm demo) is the **first vertical wedge** — a concrete,
machine-readable service that proves the loop. The protocol itself is general:
identity → x402 receipts → reputation → credit applies to every agent that earns
through x402.

### Where we are (shipped)

The core protocol is live: **14 Odra contracts on Casper Testnet** (identity,
passport, x402 receipts, RWA asset/evidence, reputation, credit pool, risk policy,
disputes, slashing, governance, RealFi registries), a console + API in production,
real x402 + EIP-712, MCP, RealFi (Stripe/Plaid), and cross-chain standards. See
[`PRODUCTION.md`](../../PRODUCTION.md) and the make-it-real phase notes
[`docs/p8`](../p8.md)–[`docs/p10`](../p10.md).

### Where we're going (this roadmap)

| Phase | Theme | One-line goal |
| ----- | ----- | ------------- |
| [p1](p1.md) ✅ | **Universal x402 receipts** | Make *any* x402 service — not just RWA — a first-class credit input *(shipped: `ServiceCategoryRegistry` + category-weighted credit, `npm run demo:x402`)* |
| [p2](p2.md) ✅ | **x402 Gateway wedge** | One-line middleware so any API becomes x402-payable + receipt-generating *(shipped: `X402Gateway` Express+Web adapters, replay guard, analytics, receipt sink; `npm run demo:gateway`)* |
| [p3](p3.md) ✅ | **Credit-as-a-service** | Other x402 protocols query Cred402 for agent creditworthiness ("Cred402 Inside") |
| [p4](p4.md) ✅ | **Mainnet-beta credit market** | Real liquidity, risk caps, insurance, governance — controlled launch |
| [p5](p5.md) ✅ | **Omnichain credit** | Agents earn/borrow on any chain under Casper-rooted credit *(shipped: `CrossChainReconciler` ties satellite draws/repayments back to the `GlobalExposureManager`, flags over-borrow + unauthorized draws, `globalHeadroom()` over-borrow guard)* |
| [p6](p6.md) ✅ | **Decentralization & data moat** | DAO governance, dispute jurors, public credit-data goods *(shipped: `DisputeJury` deterministic staked panel with reward/penalty consensus, `CreditDataCommons` k-anonymous public benchmark; DAO param governance already live via `GovernanceProposals`)* |
| [p7](p7.md) ✅ | **ML risk-engine v2** | Feature-based scoring model that learns from realized credit performance *(shipped: `RiskEngineV2` logistic-regression PD model, gradient-descent training, blended ml+rules score)* |
| [p8](p8.md) ✅ | **zk receipt proofs** | Trust-ladder Stage 4: prove receipt validity without revealing the receipt *(shipped: `ReceiptProofSystem` field commitments + Merkle anchoring + selective-disclosure proofs)* |
| [p9](p9.md) ✅ | **Enterprise RealFi GA** | Production RealFi controls: tenants, entitlements, audit export *(shipped: `EnterpriseRealFi` plan-based entitlements, quota + rate limits, exportable audit trail)* |
| [p10](p10.md) ✅ | **New service verticals** | Compute / inference / data markets as first-class credit verticals *(shipped: `ServiceVerticals` per-vertical underwriting profiles — advance rate, volatility haircut, qualification gates)* |

The north-star metric stays the same across all phases: **finalized x402 service
revenue used in credit decisions** — proof that agents are earning, receipts are
real, and credit is flowing.
