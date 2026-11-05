# Cred402 × NEAR Hackathon (Nov 1-14, 2026)

## Track

**Agent Economy** — "Give AI agents the ability to earn, spend, negotiate
and pay for services or other agents."

Cred402 already *is* an agent paying for a service: an AI agent calls a
credit-score API, gets an HTTP `402 Payment Required` challenge (the x402
protocol), pays, and receives the paid result. This submission adds a
second, independent settlement rail — native NEAR on NEAR Testnet —
alongside the project's existing Algorand x402 integration, so an agent can
pay for the same resource with whichever chain it already holds funds on.

(Cred402 is also a strong fit for **AI Security & Defense** — it is
literally a reputation/credit-score system for agents with built-in
spending-limit and replay-protection primitives — but Agent Economy is the
more direct match for what this submission builds: a new payment rail.)

## What it does

Cred402 is a pay-per-call credit-score API for AI agents. An agent calls:

```
GET /v1/x402/near/credit-score/:agentId
```

and gets back a JSON credit report — score, probability of default, risk
band, eligibility, reason codes — paid for per-call in native NEAR
(testnet), using the x402 protocol's standard `402 Payment Required`
challenge/response flow. The same resource is also sellable via Algorand
USDC (`/v1/x402/credit-score/:agentId`, pre-existing) and QIE
(`/v1/x402/qie/credit-score/:agentId`, pre-existing) — this hackathon adds
the NEAR rail.

**The problem it solves:** AI agents that transact with each other (or with
paid APIs) need a way to assess counterparty trustworthiness and a way to
actually pay per call without a subscription or an API key issued by a
human. Cred402 solves both: it is itself an x402-paid API (proving the
pattern works), and its payload is exactly the signal — a credit score,
default probability, and reason codes — an agent-economy platform needs to
decide whether to extend credit, accept a job, or route a payment to
another agent.

## What NEAR tooling this submission uses, and how

- **NEAR as a settlement rail for x402.** `lib/x402/near_gateway.ts` is a
  from-scratch x402 v2 `exact` scheme for NEAR. No `@x402/near` package
  exists yet, so this reuses `@x402/core`'s chain-agnostic wire format
  (header codecs + `PaymentRequirements`/`PaymentPayload` types — the same
  types Cred402's Algorand and QIE integrations use) and adds NEAR-specific
  verification.
- **No third-party facilitator — Cred402 verifies itself against NEAR RPC.**
  `lib/x402/near_finality.ts` reads a payer's claimed transaction back from
  the configured NEAR RPC (`EXPERIMENTAL_tx_status` + `block`), confirms it
  executed successfully, confirms the signer/receiver/amount match, and
  requires a minimum finality depth before calling the payment `confirmed`.
  This is the direct chain-abstraction pattern NEAR's docs describe for a
  resource server that wants to accept NEAR-native payments without
  depending on an external facilitator.
- **NEAR account signing (near-api-js), Chain-Signatures-ready.** The buyer
  example (`examples/near-paid-score/typescript.ts`) uses `near-api-js` to
  sign and submit a native NEAR `Transfer` action from a NEAR Testnet
  account. Because the server only ever verifies an already-signed NEAR
  transaction hash, it is already compatible with **NEAR Chain Signatures**
  without any server change: an agent that holds a key on a *different*
  chain (or no NEAR key at all) could have a NEAR MPC network derive and
  sign the same `Transfer` transaction on its behalf, and Cred402 would
  verify it identically. This extension point — and the equally
  compatible **NEAR Intents** path (swap any asset into the exact NEAR
  amount before calling `signAndSendTransaction`) — is documented in
  [`docs/near_x402.md`](docs/near_x402.md) rather than mocked, to be honest
  about what is wired up today versus what the architecture already
  supports.

## SpendGuard — the AI Security & Defense complement (NEAR smart contract)

Alongside the x402 payment rail above, this submission also ships a real
NEAR smart contract, `contracts-near/spend_guard`, built specifically for
the **AI Security & Defense** angle this file mentions above: turning an
agent's verified x402 revenue into a *protocol-enforced* spending
permission, not just an application-level check.

- `policy.rs` underwrites a credit line from an agent's metrics (ported
  from Cred402's existing Casper `RiskPolicyManager`).
- `exposure.rs` (`ExposureBook`) tracks that credit line against a global
  exposure cap (ported from Cred402's TypeScript `GlobalExposureManager`),
  so an agent can never be authorized beyond its real cap across chains.
- `spend_key.rs` turns an approved credit line into a real NEAR Function
  Call Access Key whose `allowance` **nearcore itself** enforces — the cap
  is a protocol guarantee, not just a contract `require!`.
- `scam_detection.rs` is the circuit breaker: a dispute-rate spike freezes
  the agent and revokes its live key outright, independent of remaining
  budget — proven against real nearcore access-key deletion, not mocked.
- `repay_credit_line` turns the approved credit line into an actual
  **revolving** credit line: an admin-verified repayment reduces the
  agent's outstanding exposure, the other half of a real credit score for
  an agent (draw, repay, draw again), not a one-shot budget.
- `top_up_allowance` (added 2026-11-05) closes the loop end to end: it
  re-reserves exactly the headroom a repayment freed (capped by the
  agent's own policy-approved `max_allowed`, never more) and re-mints the
  SAME still-active Function Call Access Key with a fresh on-chain
  allowance — so an agent can draw, repay, top up, and draw again on one
  continuously-live key, never needing a new identity or a new key.

**Real, live proof, not unit tests in isolation:** `tests/sandbox.rs` is a
`near-workspaces` integration test against a genuinely running local
nearcore node — deploy → policy → capped spend key → real spends → a real
on-chain `repay_credit_line` call with before/after `get_exposure` proof
that outstanding exposure actually zeroes out on the live contract → a real
on-chain `top_up_allowance` call that restores exactly that freed headroom
and re-mints the agent's original key → a real `spend_to_seller` call that
succeeds again on that SAME key, past the point its original allowance was
exhausted → a dispute spike → circuit-breaker freeze → the revoked key's
next call rejected by nearcore itself, even with budget left. Run it with:

```bash
cd contracts-near/spend_guard
cargo near build non-reproducible-wasm
cargo test --test sandbox -- --nocapture
```

**A real NEAR protocol constraint found while building `top_up_allowance`**
(not hidden, not worked around): nearcore's `AddKey` action unconditionally
rejects a public key that already exists on the account
(`ActionError::AddKeyAlreadyExists`, confirmed live against a running local
nearcore node) — there is no "update an access key's allowance" action in
the protocol. So topping up an existing key means `delete_key` then
`add_access_key_allowance` **in the same receipt** (same-account
self-actions, which nearcore always applies atomically and in order), not
a second `AddKey` call. See `spend_key::retop_spend_key`.

**Also re-verified against the real, already-deployed public NEAR Testnet
contract** (`spendguard-024e8dd6f7.testnet`, upgraded in place via `npm run
near:spend-guard:redeploy` — a `DeployContract` action replaces code only,
never storage, so every prior agent/exposure record survived untouched):
25/25 real `spend_to_seller` calls, a real `repay_credit_line` call, a real
`top_up_allowance` call that restored the exact freed headroom, one more
real `spend_to_seller` call that succeeded on that SAME original key, a
dispute spike, a freeze, and a rejected post-freeze call — all against the
live public network, not just the local sandbox. Run it yourself with `npm
run demo:near-spend-guard` (needs `.secrets/near_spend_guard_credentials.json`
from a prior `npm run near:spend-guard:deploy`).

**A second real, judge-relevant finding from this same run:** NEAR's own
legacy public RPC (`rpc.testnet.near.org`) now rejects most calls with
`-429 "WARNING! THIS ENDPOINT IS DEPRECATED!"`. Every default RPC URL in
this repo (`lib/x402/near_networks.ts`, `near_spend_guard_client.ts`,
`scripts/near_spend_guard_deploy.ts`) now defaults to FastNear's free
public RPC (`rpc.testnet.fastnear.com`) instead — `CRED402_NEAR_RPC_URL`
still overrides either way. If you cloned this repo before 2026-11-05 and
hit a `-429` running the "How to run it" steps below, pull latest or set
`CRED402_NEAR_RPC_URL=https://rpc.testnet.fastnear.com` yourself.

## How to run it (for judges)

```bash
git clone https://github.com/caelum0x/cred402.git
cd cred402
npm install
npm test            # 450/450 green, including all 14 NEAR tests. (A
                     # test/mcp_sdk.test.ts stdio-handshake test has
                     # intermittently timed out under heavy host load in
                     # some environments in the past — unrelated to the
                     # x402/NEAR payment path either way.) Re-verified
                     # 2026-11-05, 450/450.
npm run typecheck    # clean
```

**1. Start the server with the NEAR route enabled (testnet, no real funds
needed to see the 402 challenge):**

```bash
CRED402_NEAR_PAY_TO=cred402.testnet npm run start
```

**2. See the free, secret-free status probe:**

```bash
curl -s http://localhost:4021/v1/x402/near/status | jq
```

**3. See the x402 `402 Payment Required` challenge (no payment, no key):**

```bash
curl -i http://localhost:4021/v1/x402/near/credit-score/EvidenceSellerAgent
```

You'll get an HTTP 402 with a `PAYMENT-REQUIRED` header — a base64-encoded
x402 v2 challenge naming the NEAR network, the native-NEAR asset, the exact
price in yoctoNEAR, and the pay-to account.

**4. Run a real end-to-end paid call on NEAR Testnet** (free testnet
account at [near-faucet.io](https://near-faucet.io), no mainnet funds):

```bash
export CRED402_NEAR_CLIENT_URL=http://localhost:4021/v1/x402/near/credit-score/EvidenceSellerAgent
export CRED402_NEAR_EXPECTED_PAY_TO=cred402.testnet
export CRED402_NEAR_CLIENT_ACCOUNT_ID=yourname.testnet
export CRED402_NEAR_CLIENT_PRIVATE_KEY=ed25519:YOUR_SECRET_KEY
npx tsx examples/near-paid-score/typescript.ts
```

This signs and submits a real NEAR Testnet transaction, retries the paid
request with the resulting proof, and prints the verified receipt. See
[`examples/near-paid-score/README.md`](examples/near-paid-score/README.md)
for the full walkthrough and
[`docs/near_x402.md`](docs/near_x402.md) for the protocol and
architecture writeup.

## What's new in this submission (files)

- `lib/x402/near_networks.ts`, `near_rpc.ts`, `near_finality.ts`,
  `near_payment_attempt_store.ts`, `near_gateway.ts` — the NEAR x402
  resource server, self-verifying settlement, and durable exact-once replay
  protection.
- `api/near_x402_routes.ts`, `api/near_receipt_anchor.ts` — HTTP routes
  (`/v1/x402/near/status`, `/v1/x402/near/usage`,
  `/v1/x402/near/payments/:id`, `/v1/x402/near/credit-score/:agentId`) and
  Casper-rooted Universal Receipt anchoring, wired into `api/server.ts` and
  `api/state.ts` alongside the existing Algorand/QIE routes (none removed
  or modified).
- `examples/near-paid-score/typescript.ts` (+ README) — a real buyer that
  signs and submits a NEAR Testnet transaction with `near-api-js`.
- `test/near_x402.test.ts` — 14 new tests (config validation, the 402
  challenge shape, payment-signature validation, the payment attempt
  store, and NEAR RPC finality checks against a mocked RPC) — TDD, all
  green; typecheck clean. Full suite is 450/450 green (see "How to run it"
  above). Also verified end-to-end against the real NEAR Testnet RPC and a real
  on-chain payment, not just unit tests — see "Verification" in
  [`docs/near_x402.md`](docs/near_x402.md).
- `docs/near_x402.md` — protocol writeup, Chain Signatures / NEAR Intents
  extension points, Mainnet release checklist.

Existing Algorand (`examples/algorand-paid-score/`, `/v1/x402/algorand/*`)
and QIE (`/v1/x402/qie/*`) integrations are untouched.

- `contracts-near/spend_guard/` — the SpendGuard contract (`policy.rs`,
  `exposure.rs`, `spend_key.rs`, `scam_detection.rs`, `lib.rs`), 18/18 unit
  tests green, plus `tests/sandbox.rs`, a real `near-workspaces` sandbox
  integration test proving the full earn→spend→repay→top-up→spend→freeze
  loop against a genuinely running local nearcore node.
