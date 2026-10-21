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

## How to run it (for judges)

```bash
git clone https://github.com/caelum0x/cred402.git
cd cred402
npm install
npm test            # 450/450 passing, including 14 new NEAR tests
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
  green, full existing suite (436 prior tests) still green, typecheck
  clean.
- `docs/near_x402.md` — protocol writeup, Chain Signatures / NEAR Intents
  extension points, Mainnet release checklist.

Existing Algorand (`examples/algorand-paid-score/`, `/v1/x402/algorand/*`)
and QIE (`/v1/x402/qie/*`) integrations are untouched.
