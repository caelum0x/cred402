# x402 Credit-Service Marketplace — Cred402's intelligence, sold per call

> **Cred402 sells what it knows.** Every credit primitive Cred402 computes — credit
> checks, TEE-attested confidential scores, FTSO-priced position health, ML risk
> scores, underwriting simulations — is exposed as a discoverable catalog of services
> that other agents **buy per call over x402**. A request without payment returns an
> HTTP `402 Payment Required` challenge; the caller signs it and retries; the server
> verifies the proof and returns the result plus a receipt.

This is the same pay-per-call shape as KeeperHub's marketplace `call_workflow` (a
paid listing → a `402` challenge → a settled call). And the loop closes on itself:
those x402 receipts **are** Cred402's own machine-to-machine revenue — the exact
cash-flow events Cred402 turns into on-chain reputation and credit. A seller's paid
calls make that seller more creditworthy.

## The flow

```text
  Agent B wants Agent A's credit score
        │
        ▼
  GET /x402/services/credit-check          (no X-Payment header)
        │
        ▼
  402 Payment Required  ── X-Payment-* headers + a signed-shape PaymentChallenge
        │                    (payment_id, amount_motes, seller_agent, nonce, expires_at)
        ▼
  Agent B signs a PaymentAuthorization      (ed25519 over an EIP-712 typed-data digest)
        │  X-Payment: <base64 proof>
        ▼
  server verifies  ── payment_id/amount/nonce/seller/network match, signature valid,
        │             nonce + proof hash not already used (replay protection)
        ▼
  200 OK  ── { result, receipt, payer }  →  receipt anchored as real x402 revenue
```

The verifier is the real `X402Gateway` (`lib/x402/gateway.ts`), the same middleware
Cred402 puts in front of any payable route. `CreditServiceMarketplace`
(`lib/services/x402_marketplace.ts`) owns one gateway per service and a **shared**
nonce store, so replay protection spans the whole catalog. Required params are
validated *before* a challenge is issued, so a caller is never charged for a
malformed request.

The signed message is a domain-separated `PaymentAuthorization`
(`lib/x402/x402.ts`), and `authorizationDigest()` produces a standards-compliant
`\x19\x01` EIP-712 typed-data hash via `@casper-ecosystem/casper-eip-712` — verifiable
by any EIP-712-aware contract or the `casper-x402` facilitator, not just by Cred402.

## The catalog

| id | Service | Price (CSPR/call) | Resource | Required params |
|---|---|---|---|---|
| `credit-check` | Credit check — score, limit, tier, reason codes | 0.005 | `/x402/services/credit-check` | `agent_id` |
| `confidential-score` | Confidential credit score (Flare Confidential Compute / TEE) | 0.01 | `/x402/services/confidential-score` | `agent_id` |
| `position-health` | FTSO position health — borrowing power, health factor, deleverage-to-cure | 0.003 | `/x402/services/position-health` | `agent_id` |
| `risk-score` | ML risk score (probability-of-default, risk-engine v2 blended) | 0.008 | `/x402/services/risk-score` | `agent_id` |
| `underwrite` | Underwriting simulation — what-if credit line + rate | 0.004 | `/x402/services/underwrite` | `monthly_revenue_cspr` |

Source of truth: the `CREDIT_SERVICES` catalog in `lib/services/x402_marketplace.ts`.

## The revenue → reputation loop

Every paid call fires the gateway's `onReceipt` sink. In the server, that sink is
`ServerState.anchorMarketplaceReceipt` (`api/state.ts`), which records the settled
call as a **real** x402 receipt on the ledger:

```typescript
// api/state.ts — the paid call anchors real revenue
this.ledger.receipts.record_receipt({
  payer_agent: r.payer_agent,
  seller_agent: r.seller_agent,
  service_type: r.service_type,
  amount: BigInt(r.amount_motes),
  rwa_reference_hash: hashObject({ resource: r.resource }),
  result_hash: "",
  payment_proof_hash: r.payment_proof_hash,
  nonce: r.nonce,
});
```

Anchoring is best-effort (a duplicate or expired proof must never fail the paid
call), and it is the seam that closes the loop: because these receipts land on the
same ledger as every other x402 receipt, they show up in the receipt-network stats
at `GET /v1/analytics/x402` and feed the seller's verifiable revenue — the exact
signal Cred402's underwriting turns into a credit line. The marketplace is not a
side feature; it is Cred402 eating its own dog food, earning the revenue it prices
credit against.

## Worked example

`npm run x402:market` (`scripts/x402_market_run.ts`) runs the whole thing end to end
against a live ledger — discover the catalog, get a `402`, sign, get a `200`, prove
replay protection, and roll up revenue. Real output:

```text
┌───────────────────────────────────────────┐
│ Cred402 x402 Credit-Service Marketplace   │
└───────────────────────────────────────────┘

● Scene 1 — Catalog
  credit-check — Credit check · 0.005 CSPR/call → /x402/services/credit-check
  confidential-score — Confidential credit score (TEE) · 0.01 CSPR/call → /x402/services/confidential-score
  position-health — FTSO position health · 0.003 CSPR/call → /x402/services/position-health
  risk-score — ML risk score (PD) · 0.008 CSPR/call → /x402/services/risk-score
  underwrite — Underwriting simulation · 0.004 CSPR/call → /x402/services/underwrite

● Scene 2 — GET /x402/services/credit-check (no payment)
  402 Payment Required — 0.005 CSPR to EvidenceSellerAgent
  payment_id pay-6be7ae3fa0c4972d

● Scene 3 — Retry with X-Payment → 200
  paid by RWARequestAgent · receipt rcpt-423acab20db00c05
  credit check: score n/a · tier n/a · limit n/a CSPR

● Scene 4 — Replay the same proof
  rejected: unknown or expired payment_id; request a fresh 402 first

● Scene 5 — Marketplace revenue
  {"total_calls":2,"total_revenue_motes":"13000000","by_service":{"credit-check":1,"risk-score":1}}
```

Notes on the trace:

- **Scene 2** is a real `402`: the `X-Payment-*` headers and the embedded
  `PaymentChallenge` carry a fresh `payment_id`, `nonce`, and `expires_at`.
- **Scene 3** signs the challenge with the buyer agent's ed25519 key and gets a
  `200` with a receipt. (Here the subject agent has no open credit line yet, so the
  credit-check result reads `n/a` — the payment and receipt are what the demo
  exercises, not a seeded score.)
- **Scene 4** replays the *same* signed proof and is correctly rejected: the
  gateway consumes the one-time challenge on success, so the `payment_id` is already
  gone — request a fresh `402` first. Nonce and proof-hash reuse are likewise
  single-use.
- **Scene 5** rolls up two paid calls (`credit-check` at 0.005 + `risk-score` at
  0.008 = 0.013 CSPR = `13000000` motes) — Cred402's own settled x402 revenue.

## Surfaces

The marketplace is reachable from every Cred402 surface, all backed by the same
`CreditServiceMarketplace` on the shared server state.

| Surface | Entry point | What it does |
|---|---|---|
| **HTTP (402-gated)** | `POST` / `GET` `/x402/services/:id` (`api/server.ts`) | The raw pay-per-call endpoint. No `X-Payment` → `402` + challenge; valid proof → `200` + `{ result, receipt, payer }`. Params via query string or JSON body. |
| **MCP** | `cred402.list_services`, `cred402.buy_service` (`mcp/tools.ts`) | `list_services` returns the catalog + live call/revenue counters. `buy_service` runs the full `402 → sign → 200` flow with a buyer agent's key and returns `{ challenge, paid }`. |
| **/v1 discovery** | `GET /v1/services`, `GET /v1/services/receipts` (`api/v1/router.ts`) | `/v1/services` returns `{ services, stats }`; `/v1/services/receipts` returns the settled marketplace receipt log. |
| **Console** | x402 tab → Service Marketplace panel (`frontend/src/components/X402Playground.tsx`) | Reads `GET /api/marketplace/services` (`{ services, stats, receipts }`) and drives a self-paying purchase via `POST /api/demo/buy-service`. |
| **Script** | `npm run x402:market` (`scripts/x402_market_run.ts`) | The worked example above — catalog → 402 → sign → 200 → replay-rejected → revenue. |

The console's `POST /api/demo/buy-service` and the MCP `buy_service` tool both use
`ServerState.demoBuyService` (`api/state.ts`): it fetches the `402`, signs with the
economy's buyer agent, retries, and returns the challenge + the paid decision — a
real end-to-end x402 purchase you can watch in the UI.

## What's real vs sim

Following the repo's convention of *real-behind-env + deterministic sim*:

- **Real, always:** the x402 verifier. Signatures are genuine ed25519 over a
  standards-compliant EIP-712 typed-data digest (`@casper-ecosystem/casper-eip-712`),
  and `verifyPayment` (`lib/x402/x402.ts`) checks `payment_id`, `amount`, `nonce`,
  `seller`, network, and expiry before accepting. Replay protection (single-use
  challenge + nonce + proof hash) is real. Receipts are anchored on the real ledger
  and surface at `/v1/analytics/x402`.
- **Real when configured:** with `CRED402_X402_FACILITATOR_URL` set, settlement can
  route through the real `make-software/casper-x402` facilitator (`lib/x402/facilitator.ts`),
  the canonical Casper x402 V2 facilitator that pays gas and submits on-chain. Its
  status is visible at `GET /api/x402/facilitator`.
- **Sim (default):** with no facilitator configured, the gateway verifies the proof
  and emits the receipt locally — the same `402 → sign → 200` shape and the same
  receipt commitment, so the whole marketplace demos with no key and no network. The
  underlying service results (credit oracle, risk engine, position health) run on the
  in-memory ledger.

## References

- Marketplace core: [`lib/services/x402_marketplace.ts`](../lib/services/x402_marketplace.ts)
- x402 gateway + protocol: [`lib/x402/gateway.ts`](../lib/x402/gateway.ts) · [`lib/x402/x402.ts`](../lib/x402/x402.ts)
- Server wiring (anchoring, demo buy): [`api/state.ts`](../api/state.ts)
- KeeperHub's `call_workflow` marketplace shape this mirrors: [keeperhub_integration.md](keeperhub_integration.md)
