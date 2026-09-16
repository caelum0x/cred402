# Cred402 — Paid Endpoint Activation Checklist (owner-gated)

The one product Cred402 sells is the pay-per-call Credit Score API:

```
GET /v1/x402/credit-score/:agentId   →   0.01 USDC over x402 on Algorand
```

On the current deploy this endpoint returns **HTTP 503 `algorand_x402_not_configured`**
because the paid path is deliberately **fail-closed**: it never becomes free and never
advertises a placeholder receiver. `GET /v1/x402/algorand/status` reports
`{"configured": false, ...}` until every required variable below is set. The pricing and
docs pages are now **status-aware** — they read that probe and render "activating" instead
of a live-price CTA while `configured:false`, so the site never sells a dead endpoint.

This checklist is the exact set of environment variables the owner must set (in the Render
service and mirrored in `.env`) to flip the probe to `configured:true`. Setting them is
owner-gated; nothing here deploys on its own.

---

## 1. Required to turn the paid endpoint ON (testnet)

| Variable | Required | Example / default | Notes |
|---|---|---|---|
| `CRED402_ALGORAND_PAY_TO` | **yes** | `<58-char Algorand address>` | USDC receiver. Must be a valid Algorand address, opted into the USDC ASA. No default — its absence is the current 503 reason. |
| `CRED402_ALGORAND_NETWORK` | no | `testnet` (default) | `testnet` \| `mainnet` \| a supported Algorand CAIP-2 id. |
| `CRED402_ALGORAND_PRICE_MICRO_USDC` | no | `10000` (0.01 USDC) | Positive integer, micro-USDC. |
| `CRED402_ALGORAND_FACILITATOR_URL` | no | `https://facilitator.goplausible.xyz` | HTTP(S), no credentials/query/fragment. HTTPS required on mainnet/prod. |
| `CRED402_ALGORAND_FACILITATOR_TIMEOUT_MS` | no | `10000` | Integer 1–60000. |
| `CRED402_ALGORAND_INDEXER_URL` | no | `https://testnet-idx.algonode.cloud` | Used to independently confirm USDC finality. HTTPS required on mainnet/prod. |
| `CRED402_ALGORAND_INDEXER_TOKEN` | no | *(empty)* | Only if your Indexer needs an API token. |
| `CRED402_ALGORAND_INDEXER_TIMEOUT_MS` | no | `5000` | Integer 250–30000. |
| `CRED402_ALGORAND_MIN_FINALITY_ROUNDS` | no | `4` | Integer 1–1000. |
| `CRED402_ALGORAND_MISSING_TX_THRESHOLD` | no | `3` | Integer 2–100. |
| `CRED402_ALGORAND_RECONCILE_INTERVAL_MS` | no | `15000` | Integer 1000–3600000. |
| `CRED402_ALGORAND_MISSING_TX_GRACE_MS` | no | `120000` | Integer 30000–86400000. |

USDC ASA ids are selected automatically by network: testnet `10458941`, mainnet `31566704`.

**Minimum viable testnet activation** is a single variable:

```bash
export CRED402_ALGORAND_PAY_TO=<funded, USDC-opted-in testnet address>
# defaults cover network=testnet, price=10000, GoPlausible facilitator, algonode indexer
```

Then verify:

```bash
curl -sS https://cred402-1.onrender.com/v1/x402/algorand/status   # → "configured": true
npm run x402:algorand:check                                        # scripted readiness probe
```

When `configured:true`, `/pricing` and `/docs` automatically switch to the live state
(testnet banner + real price/network/receiver pulled from the probe).

---

## 2. Durable persistence (disqualifying if skipped)

The ledger, API keys, rate-limit buckets, and x402 payment-replay barrier are **in-memory
per instance**. On Render free tier the instance sleeps/restarts, so without a data dir a
credit bureau forgets its entire history — unacceptable for a credit product.

| Variable | Required | Example | Notes |
|---|---|---|---|
| `CRED402_DATA_DIR` | **strongly** (required on mainnet/prod) | `/var/data` | Persists the append-only ledger journal, durable external-receipt proofs, and the Algorand payment-attempt store (exactly-once replay protection). |

On Render, back this with a **persistent disk** mounted at the same path (not the ephemeral
container filesystem). `loadAlgorandX402Config` refuses to enable the paid path on
mainnet/prod unless `CRED402_DATA_DIR` is set, precisely to prevent replay-protection loss.

Verify persistence survives a restart:

```bash
# 1. record an external receipt / run a paid attempt
# 2. restart the service
# 3. GET the same /v1/x402/external-receipts/<id> and /api/state — history is still present
```

---

## 3. Mainnet (real USDC) — extra gates

Mainnet is intentionally hard to enable by accident. All of the following are required
**together** or the endpoint stays 503:

| Variable | Value |
|---|---|
| `CRED402_ALGORAND_NETWORK` | `mainnet` |
| `CRED402_ENV` | `mainnet` (must match the network) |
| `CRED402_ALGORAND_MAINNET_RELEASE_ACK` | `I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS` |
| `CRED402_PUBLIC_URL` | pinned **HTTPS** origin (e.g. `https://cred402-1.onrender.com`) |
| `CRED402_DATA_DIR` | set (durable disk) |
| facilitator + indexer URLs | must be **HTTPS** |

Mainnet is also the Global x402 Challenge environment. Keep the receiver address stable
once set — discovery, dashboards, receipts, and leaderboard rankings all key on it — and
verify attribution after the first payment with `npm run x402:algorand:challenge-check`.
Submission requirements and the ordered activation runbook:
[`X402_GLOBAL_CHALLENGE.md`](./X402_GLOBAL_CHALLENGE.md).

`CRED402_PUBLIC_URL` is also recommended on testnet so Bazaar discovery + receipt URLs use
the canonical origin instead of a request host.

---

## 4. REST auth (separate from the x402 paid path)

REST reads under `/v1/*` are open and free by default in development
(`CRED402_ENV=development` → `authRequired=false`). To gate them, set:

| Variable | Notes |
|---|---|
| `CRED402_AUTH_REQUIRED` | `true` to require an API key on mutating routes. |
| `CRED402_ADMIN_API_KEY` | required whenever auth is enabled; used to mint scoped keys via `POST /v1/admin/api-keys`. |
| `CRED402_RATE_WINDOW_MS` / `CRED402_RATE_MAX` | per-key rate limit (default 60000ms / 120). |

Note: API keys and rate-limit buckets are in-memory today, so they also depend on
`CRED402_DATA_DIR` semantics for durability across restarts. The x402 paid endpoint does
**not** use API keys — the payment is the authorization.

---

## Quick reference — probe outcomes

| `/v1/x402/algorand/status` | Meaning | Site behavior |
|---|---|---|
| `configured: false` + `reason` | paid path off (missing/invalid config) | pricing/docs show "activating", CTA points to docs |
| `configured: true`, `release_tier: testnet` | live on testnet USDC | pricing/docs show live testnet banner + real price |
| `configured: true`, `release_tier: mainnet` | live on real USDC | pricing/docs show live mainnet state |
