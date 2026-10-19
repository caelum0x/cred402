# QIE x402 credit-score endpoint

Cred402's QIE integration (QIE Blockchain Hackathon 3.0, "AI & Autonomous
Agents" track — `hackathon.qie.digital`) sells the same resource as the
Algorand integration, priced on QIE instead:

```text
GET /v1/x402/qie/credit-score/:agentId
```

The endpoint returns the policy score, probability of default, risk band,
eligibility, reason codes, and verified x402 revenue — it uses the same
oracle and risk engine as the rest of Cred402 (`state.x402CreditScore`); the
QIE route is a payment and distribution layer, not a forked scoring model.

## Why this integration is small

QIE is an EVM-compatible Layer-1 (Cosmos SDK consensus + Ethereum JSON-RPC
`eth_*` compatibility — the hackathon's own builder quickstart says to point
an existing Hardhat/Foundry workflow at the QIE RPC endpoint). Cred402
therefore reuses the exact same chain-agnostic `@x402/core` resource-server
primitives the Algorand integration uses (`x402ResourceServer`,
`x402HTTPResourceServer`, `HTTPFacilitatorClient`) and only swaps the
registered scheme: `ExactEvmScheme` from `@x402/evm` instead of
`ExactAvmScheme` from `@x402/avm`. No bespoke signing, encoding, or ABI code
was written — see [`lib/x402/qie_gateway.ts`](../lib/x402/qie_gateway.ts).

## What research could not confirm (and how the code fails closed instead)

- **QUSDC's ERC-20 contract address.** QIE's stablecoin, QUSDC, is documented
  at `docs.stable.qie.digital` as a 1:1 USDC-backed receipt token, but its
  contract address, decimals, and testnet availability were not confirmed.
  `CRED402_QIE_ASSET_ADDRESS` is therefore a **required** env var with no
  default — the route returns `503` until an operator supplies a real,
  verified token contract. It never guesses an address.
- **A confirmed x402 EVM facilitator for QIE.** Unlike Algorand's GoPlausible
  facilitator, no default/public x402 facilitator for QIE is confirmed to
  exist. `CRED402_QIE_FACILITATOR_URL` is therefore also **required** with no
  default. Point it at a self-hosted facilitator (built from `@x402/evm`'s
  `FacilitatorEvmSigner` + `ExactEvmScheme`) or a third-party one that
  verifies/settles the `exact` scheme on `eip155:1983` (testnet) /
  `eip155:1990` (mainnet).
- **A public Mainnet RPC endpoint.** Only a testnet RPC
  (`https://rpc1testnet.qie.digital/`) was independently confirmed by
  research. `CRED402_QIE_RPC_URL` has a testnet default but is **required**
  with no default on Mainnet.

Without all three configured, `GET /v1/x402/qie/credit-score/:agentId`
returns `503` and never advertises a placeholder receiver, a guessed token,
or an unverified facilitator as if it were real.

## Configuration

```bash
export CRED402_QIE_PAY_TO=0xYOUR_EVM_ADDRESS
export CRED402_QIE_NETWORK=testnet
export CRED402_QIE_RPC_URL=https://rpc1testnet.qie.digital/
export CRED402_QIE_ASSET_ADDRESS=0xYOUR_VERIFIED_TOKEN_CONTRACT   # QUSDC once confirmed
export CRED402_QIE_ASSET_SYMBOL=QUSDC
export CRED402_QIE_ASSET_DECIMALS=6
export CRED402_QIE_PRICE_BASE_UNITS=10000   # 0.01 token at 6 decimals
export CRED402_QIE_FACILITATOR_URL=https://your-facilitator.example.com
export CRED402_DATA_DIR=/var/lib/cred402
npm run start
```

See [`.env.example`](../.env.example) for every variable and its defaults.

## Inspect the unpaid challenge

```bash
curl -i "http://localhost:4021/v1/x402/qie/credit-score/YOUR_AGENT_ID"
```

For a strict, payment-free preflight check:

```bash
export CRED402_QIE_EXPECTED_PAY_TO="$CRED402_QIE_PAY_TO"
export CRED402_QIE_EXPECTED_ASSET_ADDRESS="$CRED402_QIE_ASSET_ADDRESS"
npm run x402:qie:check -- \
  "http://localhost:4021/v1/x402/qie/credit-score/YOUR_AGENT_ID"
```

The preflight (`lib/x402/qie_client.ts`) rejects anything other than exactly
one x402 v2 `exact` option on the selected QIE network, the configured asset
contract and receiver, a hard price ceiling, and a matching resource URL. It
never signs or submits a transaction.

## Settlement and independent finality

The route uses a durable exact-once attempt ledger
(`lib/x402/qie_payment_attempt_store.ts`, same role as
`AlgorandPaymentAttemptStore`): it stores a digest, not the raw
`PAYMENT-SIGNATURE`, and replays the same paid response after safe retries or
restarts. Facilitator success produces a provisional settlement; Cred402
independently re-reads the transaction receipt from the configured QIE RPC
(`lib/x402/qie_finality.ts`) and confirms an ERC-20 `Transfer` log moved at
least the expected amount to the configured receiver, with a configurable
minimum confirmation depth, before calling the payment `confirmed`. This
plays the same role Algorand's independent Indexer check plays, since no
Indexer-equivalent REST API for QIE was confirmed by research — Cred402 reads
its own RPC directly instead of trusting the facilitator's report alone.

`GET /v1/x402/qie/payments/:attemptId` exposes only coarse lifecycle,
transaction, and confirmation-count data — never the paid report, payer
identity, or raw signature.

## Status probe

`GET /v1/x402/qie/status` is free, secret-free, and never initializes the
facilitator — it mirrors `/v1/x402/algorand/status`.

## Mainnet release checklist

1. Confirm the real QUSDC ERC-20 contract address on QIE Mainnet (chain 1990)
   and set `CRED402_QIE_ASSET_ADDRESS` to it.
2. Stand up or confirm a production x402 EVM facilitator for QIE and set
   `CRED402_QIE_FACILITATOR_URL` to its HTTPS endpoint.
3. Set `CRED402_QIE_RPC_URL` to a trustworthy QIE Mainnet RPC endpoint and
   confirm `eth_chainId` returns `0x7c6` (1990).
4. Mount a persistent volume and set `CRED402_DATA_DIR` to that mount.
5. Set `CRED402_ENV=mainnet`, `CRED402_QIE_NETWORK=mainnet`, and
   `CRED402_PUBLIC_URL` to the public HTTPS origin.
6. Set `CRED402_QIE_MAINNET_RELEASE_ACK` exactly to
   `I_ACKNOWLEDGE_REAL_QUSDC_MAINNET_PAYMENTS`.
7. Make one real external Mainnet payment and confirm the `Transfer` log and
   confirmation depth reconcile via `GET /v1/x402/qie/payments/:attemptId`.
8. Record the public endpoint, transaction hash, repository, and the
   hackathon's required fields (GitHub repo link, live demo URL, deployed
   contract address, track = "AI & Autonomous Agents") ahead of the
   2026-11-30 submission deadline.

## Known gaps vs. the Algorand integration (tracked, not hidden)

- ~~No Casper anchoring of QIE settlements yet~~ **Built.** `api/qie_receipt_anchor.ts`
  mirrors `algorand_receipt_anchor.ts`: `state.anchorQieCreditScoreSettlement`
  turns a settled QIE payment into the same Casper-rooted Universal Receipt
  Envelope every other satellite chain uses (`qie:<payer>` identity,
  `qie-erc20:<contract>` asset), anchored provisional until
  `reconcileQiePayment`'s RPC finality check confirms it, then finalized or
  challenged. The credit-score response carries `external_receipt_id` /
  `external_receipt_url` / `casper_anchor_status`; the proof is public at
  `GET /v1/x402/external-receipts/:id` (the same endpoint Algorand's receipts
  use — receipt ids are a shared content hash, not chain-specific). Covered
  by `test/qie_receipt_anchor.test.ts` (6 tests, against a real `Ledger`).
- No combined release-check / readiness script yet (Algorand has
  `x402:algorand:ready` and `x402:algorand:release-check`, which fetch live
  payer/receiver balances and write a signed evidence artifact). QIE has the
  payment-free preflight check (`x402:qie:check`) but not yet the
  balance-readiness or evidence-artifact scripts — add them once a facilitator
  and the QUSDC contract address are confirmed and testable end-to-end.
- No Bazaar-style discovery listing (QIE has no confirmed equivalent catalog
  yet, so none was wired in to avoid overclaiming discoverability that
  doesn't exist).

Do not create synthetic/self-payment volume. One genuine end-to-end payment
against a real facilitator and a real QUSDC (or interim test ERC-20) contract
is more useful than fabricated traffic.
