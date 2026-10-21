# NEAR x402 credit-score endpoint

Cred402's NEAR integration (NEAR Hackathon, Nov 1-14, 2026,
nearhackathon.com) sells the same resource as the Algorand and QIE
integrations, priced in native NEAR instead:

```text
GET /v1/x402/near/credit-score/:agentId
```

The endpoint returns the policy score, probability of default, risk band,
eligibility, reason codes, and verified x402 revenue — it uses the same
oracle and risk engine as the rest of Cred402 (`state.x402CreditScore`); the
NEAR route is a payment and distribution layer, not a forked scoring model.

## Why this integration has no facilitator

Algorand settles through GoPlausible's facilitator; QIE requires an
operator to configure one. NEAR has neither an EVM nor an AVM virtual
machine, so no `@x402/near` scheme package exists yet, and no x402
facilitator for NEAR is confirmed to exist. Rather than bolt NEAR onto a
scheme built for a different chain, `lib/x402/near_gateway.ts` is a small,
honest, from-scratch `exact`-scheme implementation:

- It reuses `@x402/core`'s chain-agnostic wire format — the same
  `encodePaymentRequiredHeader` / `decodePaymentSignatureHeader` /
  `encodePaymentResponseHeader` codecs and `PaymentRequirements` /
  `PaymentPayload` types every other x402 integration in this repo uses
  (`Network` is `${string}:${string}`, so `near:testnet` is a valid id).
- It needs **no third-party facilitator**. A NEAR account signs and submits
  a native `Transfer` action to the configured pay-to account, then presents
  the resulting transaction hash as payment proof. Cred402 reads that
  transaction back from its own configured NEAR RPC endpoint
  (`lib/x402/near_finality.ts`) and only settles once the transfer is
  independently confirmed — Cred402 is its own facilitator, with no extra
  hop and nothing to self-host.

`GET /v1/x402/near/status` reports `"facilitator": "self-verified"` for
exactly this reason.

## How a NEAR account pays (and how Chain Signatures extends it)

The reference buyer (`examples/near-paid-score/typescript.ts`) holds a plain
NEAR Testnet account and signs directly with `near-api-js`. That is the
simplest path and the one this submission demonstrates end-to-end on
Testnet.

The same flow is NEAR Chain Signatures-ready without changing the server at
all: Chain Signatures let an account on another chain (or an AI agent with
no NEAR-native key of its own) have a NEAR MPC network derive and sign a
NEAR transaction on its behalf. Whatever signs, the result is still an
ordinary signed NEAR `Transfer` transaction with a transaction hash — the
same shape this route already verifies. An agent that only holds, say, an
Ethereum key could use Chain Signatures to pay this endpoint without ever
holding NEAR directly. This is deliberately left as the extension point
(documented, not faked) rather than wiring in a mocked MPC signer.

## Configuration

```bash
export CRED402_NEAR_PAY_TO=cred402.testnet
export CRED402_NEAR_NETWORK=testnet
export CRED402_NEAR_RPC_URL=https://rpc.testnet.near.org
export CRED402_NEAR_PRICE_YOCTO=10000000000000000000000   # 0.01 NEAR
export CRED402_NEAR_MIN_FINALITY_BLOCKS=2
export CRED402_DATA_DIR=/var/lib/cred402
npm run start
```

See [`.env.example`](../.env.example) for every variable and its defaults.

## Inspect the unpaid challenge

```bash
curl -i "http://localhost:4021/v1/x402/near/credit-score/YOUR_AGENT_ID"
```

The `402` response carries a `PAYMENT-REQUIRED` header: a base64-encoded
x402 v2 challenge with exactly one `accepts[]` option — scheme `exact`,
network `near:testnet` (or `near:mainnet`), asset `near-native`, the
configured price in yoctoNEAR, and the configured pay-to account.

## Settlement and independent finality

The route uses a durable exact-once attempt ledger
(`lib/x402/near_payment_attempt_store.ts`, same role as
`QiePaymentAttemptStore` / `AlgorandPaymentAttemptStore`): it stores a
digest, not the raw `PAYMENT-SIGNATURE`, and replays the same paid response
after safe retries or restarts.

On a payment attempt, Cred402:

1. Decodes `PAYMENT-SIGNATURE` and checks it matches this route's network,
   asset, receiver, and price exactly (`NearCreditScoreGateway.authorize`).
2. Independently reads the claimed transaction back from the configured
   NEAR RPC (`EXPERIMENTAL_tx_status`), confirms it succeeded, confirms the
   signer and receiver match, and confirms a `Transfer` action moved at
   least the expected amount of yoctoNEAR (`NearCreditScoreGateway.settle`
   → `verifyNearAssetTransfer`).
3. Settles immediately once that transfer is confirmed present and
   correct, then asynchronously re-checks finality depth
   (`reconcileNearPayment`, same periodic-reconciliation pattern as the
   Algorand/QIE routes) until the transaction has been included for at
   least `CRED402_NEAR_MIN_FINALITY_BLOCKS` blocks, at which point the
   Casper-rooted receipt is finalized.

`GET /v1/x402/near/payments/:attemptId` exposes only coarse lifecycle,
transaction, and confirmation-count data — never the paid report, payer
identity, or raw signature.

## Status and usage probes

- `GET /v1/x402/near/status` is free, secret-free, and never touches the
  NEAR RPC — it mirrors `/v1/x402/algorand/status` / `/v1/x402/qie/status`.
- `GET /v1/x402/near/usage` is a free, aggregate-only proof of real paid
  volume: paid request count, unique payers, total yoctoNEAR, and the 10
  most recent finalized receipts (each pointing at its public proof URL).

## Receipt anchoring

`api/near_receipt_anchor.ts` mirrors `algorand_receipt_anchor.ts` /
`qie_receipt_anchor.ts`: `state.anchorNearCreditScoreSettlement` turns a
settled NEAR payment into the same Casper-rooted Universal Receipt Envelope
every other satellite chain uses (`near:<account>` identity,
`near-native:NEAR` asset), anchored provisional until
`reconcileNearPayment`'s finality check confirms it, then finalized or
challenged. The credit-score response carries `external_receipt_id` /
`external_receipt_url` / `casper_anchor_status`; the proof is public at
`GET /v1/x402/external-receipts/:id` (the same endpoint every chain's
receipts use — receipt ids are a shared content hash, not chain-specific).

## Mainnet release checklist

1. Fund and confirm a real NEAR Mainnet pay-to account.
2. Set `CRED402_NEAR_RPC_URL` to a trustworthy NEAR Mainnet RPC endpoint.
3. Mount a persistent volume and set `CRED402_DATA_DIR` to that mount.
4. Set `CRED402_ENV=mainnet`, `CRED402_NEAR_NETWORK=mainnet`, and
   `CRED402_PUBLIC_URL` to the public HTTPS origin.
5. Set `CRED402_NEAR_MAINNET_RELEASE_ACK` exactly to
   `I_ACKNOWLEDGE_REAL_NEAR_MAINNET_PAYMENTS`.
6. Make one real external Mainnet payment and confirm the `Transfer` action
   and finality depth reconcile via `GET /v1/x402/near/payments/:attemptId`.

## Known gaps (tracked, not hidden)

- No NEAR Intents / cross-chain settlement path yet — this submission
  settles directly in native NEAR on NEAR Testnet. NEAR Intents (swap any
  supported asset into the exact NEAR amount this route expects at
  settlement time) is the natural next step and does not require changing
  the server: it would just change what the *payer* does before calling
  `account.signAndSendTransaction`.
- No Chain Signatures-based signer wired into the reference buyer example
  yet (see "How a NEAR account pays" above) — the server-side verification
  already supports it with no changes, since it only ever sees a signed
  NEAR transaction hash, never how it was signed.
- No NEP-141 (fungible token / stablecoin) pricing option yet; only native
  NEAR. Adding one is a matter of checking `FunctionCall` actions calling
  `ft_transfer` instead of `Transfer` actions in `near_finality.ts`.

Do not create synthetic/self-payment volume. One genuine end-to-end Testnet
payment is more useful than fabricated traffic.
