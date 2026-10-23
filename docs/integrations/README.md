# Integrating cred402 on top of your payment rail

STRATEGY-2026-10-23.md's §2 "layer axis" move: Skyfire, Nevermined and
Coinbase's own x402 reference stack are payment rails, not underwriting.
They answer "can this agent pay me right now?" — not "should I extend this
agent credit, and how much?" cred402 answers the second question, and it
does not care which rail you used to answer the first.

Every sample in this directory calls the **same** real, live endpoint:

```
GET /v1/credit-score/:agentId
```

- No x402 payment required — it is a normal scoped/rate-limited `v1` REST
  GET, authenticated the same way as every other `v1` route (optional
  `Authorization: Bearer <key>` or `X-API-Key: <key>`; anonymous callers get
  the default public rate limit, a key gets a higher one — see
  `POST /v1/admin/api-keys`).
- Returns `lib/services` / `RiskPolicyManager`'s real credit score, PD, risk
  band, eligibility, reason codes and verified x402 revenue for any agent
  already known to cred402 — the identical logic the chain-specific **paid**
  routes serve (`GET /v1/x402/credit-score/:id` for Algorand,
  `GET /v1/x402/qie/credit-score/:id`, `GET /v1/x402/near/credit-score/:id`),
  just without a second payment hop for an integrator who already bills
  their own callers.
- Returns a real `404 agent_not_found` for an agent cred402 has never seen —
  it never fabricates a score for an unknown identity.

If you want cred402 itself to be the payment-metered boundary (0.01
USDC/lookup, no monthly minimum — see `/pricing.html`), use the chain-
specific paid routes instead; those are documented in `docs/algorand_x402.md`,
`docs/qie_x402.md`, `docs/near_x402.md`.

## Per-rail samples

- [`skyfire.md`](./skyfire.md) — gate a Skyfire KYA-authenticated agent call
  behind a cred402 credit check before fulfilling it.
- [`nevermined.md`](./nevermined.md) — underwrite before settling a
  Nevermined-metered agent-to-agent payment.
- [`coinbase-x402.md`](./coinbase-x402.md) — the "sits on top of x402"
  pattern for any agent already using the open x402 standard directly
  (Coinbase's reference facilitator or any other).

Each sample is a complete, runnable snippet — not pseudocode — against a
local `npm run dev` instance (`http://localhost:4021`) or the hosted
reference deployment (`https://cred402-1.onrender.com`).
