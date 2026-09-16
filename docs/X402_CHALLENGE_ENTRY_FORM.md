# Global x402 Challenge — entry form draft

Field-by-field draft for the submission form (deadline **September 30**). Copy the
answers, fix anything marked **CONFIRM**, and fill the two **BLOCKED** fields once the
endpoint is live.

Submission requirement status and the activation runbook:
[`X402_GLOBAL_CHALLENGE.md`](./X402_GLOBAL_CHALLENGE.md).

---

## Ready to paste

**First name** · `Umut Arhan`
**Last name** · `Subaşı` — **CONFIRM** spelling/diacritics as you want it printed.

**Email** · `subasiarhan3@gmail.com`

**Country** · `Türkiye` — **CONFIRM**.

**X (Twitter) project profile** · *none yet*. The form recommends a project account rather
than a personal one, and it is used for promotion. **CONFIRM** — either create
`@cred402` and put it here, or leave blank (the field is optional).

**Project name** · `Cred402`

### Project one-liner

> Cred402 sells agent creditworthiness as a paid API: an autonomous agent pays 0.01 USDC
> over x402 on Algorand and gets back an underwritten credit decision on another agent.

### Project description

> **The problem.** Autonomous agents are starting to earn real money through x402, but
> nothing underwrites them. An agent deciding whether to extend credit, capital, or
> unsecured service to another agent has no counterparty history to price the risk from —
> there is no credit bureau for machines. Wallets get DeFi; workers get nothing.
>
> **What we built.** Cred402 turns verifiable x402 payment receipts into reputation and
> credit. Every x402 settlement is a signed, machine-to-machine cash-flow event, so a
> stream of them is exactly what underwriting has always wanted: revenue you cannot
> fake. Cred402 ingests those receipts, scores the earning agent with an explainable risk
> policy, and issues a credit decision.
>
> **How x402 on Algorand is used.** That decision is itself sold over x402 on Algorand, as
> one composable resource:
>
> `GET /v1/x402/credit-score/:agentId` — 0.01 USDC, `exact` scheme, USDC ASA 31566704
>
> The paid response returns the policy score, probability of default, risk band,
> eligibility, reason codes, verified x402 revenue, and the model/policy provenance behind
> the decision. Payments verify and settle through the GoPlausible facilitator with Bazaar
> discovery, and the resource is tagged `x402-global-challenge` in the accepted payment
> option's `extra`.
>
> Settlement is not taken on trust. After the facilitator reports success, Cred402
> independently reads the transaction from a pinned Algorand Indexer and checks the
> transaction id, sender, receiver, ASA, amount, confirmed round, and a minimum
> confirmation depth before the receipt is finalized and allowed to count toward revenue
> or reputation. Mismatches and repeatedly missing transactions go to refund review rather
> than being counted. Exactly-once settlement is enforced by a durable claim on a digest
> of the payment proof, so an exact retry replays the stored response instead of charging
> twice, and the raw payment signature is never persisted.
>
> **Target users.** Agent frameworks and marketplaces that need counterparty risk on the
> agents they route work to; x402 sellers deciding whether to serve an unknown agent
> unsecured; and agent-facing lenders extending working capital against x402 cash flow.
> The payment layer is chain-agnostic — Algorand, Casper, and EVM receipts all feed the
> same score — which makes Algorand x402 the distribution surface for a cross-chain credit
> signal, not a single-chain demo.

**GitHub repository URL** · `https://github.com/caelum0x/cred402`

Public, Apache-2.0. Algorand code: `lib/x402/` (resource server, payment client, release
gate, challenge tag), `api/algorand_x402_routes.ts`, `scripts/algorand_x402_*.ts`,
`examples/algorand-paid-score/` (standalone TypeScript and Python buyers). Submitted to
the Electric Capital taxonomy as
[electric-capital/open-dev-data#2988](https://github.com/electric-capital/open-dev-data/pull/2988).

### Team

Solo. **CONFIRM** the background line — this is a placeholder you should make accurate:

> Umut Arhan Subaşı, subasiarhan3@gmail.com — solo founder and engineer. Sole author of
> Cred402: the risk policy and scoring engine, the Algorand x402 resource server and
> settlement-finality pipeline, the multi-chain receipt ingestion layer, and the console.

---

## Blocked until the endpoint is live

**Leaderboard wallet** — the `payTo` address the Foundation uses to match on-chain
volume. This is `CRED402_ALGORAND_PAY_TO`. It does not exist yet, and it must be the
*same* address that settles the real payment, because rankings key on it. See
[activation](./X402_GLOBAL_CHALLENGE.md#activation-owner-gated).

**Demo video (3–5 minutes)** — must show the project, its key features, and how it uses
x402 and Algorand. The existing `media/cred402-demo.mp4` and
`media/cred402-hackathon-demo.mp4` do **not** qualify: both are roughly 90 seconds and
show the Casper and KeeperHub × Flare arcs, not Algorand x402. Record a new one after
activation so it can show a real Mainnet settlement.

Suggested shot list, in the order the protocol actually happens:

1. The problem in one sentence, over the console.
2. `curl -i` the paid endpoint unpaid → real `402` with the decoded `PAYMENT-REQUIRED`
   header on screen: x402 v2, single `exact` option, Algorand Mainnet, USDC ASA
   31566704, receiver, price, and `extra.tag=x402-global-challenge`.
3. The console's **Algorand x402** tab decoding that same challenge in the browser.
4. `npm run x402:algorand:pay -- --pay --mainnet` — show the payment details, the typed
   confirmation phrase, then the paid credit report.
5. The independent finality check: the Algorand Indexer confirming the transaction, the
   attempt reaching `confirmed`, the receipt reaching `finalized`.
6. `npm run x402:algorand:challenge-check` — all five requirements passing, with the
   Bazaar catalogue entry and the leaderboard row.
7. Why this composes: the score is itself an x402 resource other agents can buy.
