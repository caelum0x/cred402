# QIE Blockchain Hackathon 3.0 — submission readiness (2026-10-23)

Verified against the actual repo state today. Deadline: confirmed **2026-11-30**
(matches `docs/qie_x402.md`, `docs/SUBMISSIONS.md`, `README.md` — no contradiction
found anywhere in the repo). The categories page at
`hackathon.qie.digital/dashboard/categories` is login-gated and could not be
fetched from here — see "Owner-only" below before picking a track.

## Current repo state (verified just now)

- `npm test` → **450/450 passing**, 0 failures. (Earlier reports said 423/423;
  the suite has grown since — still fully green.)
- `npm run typecheck` → clean, no errors.
- `git status` → clean, nothing uncommitted. Latest commit: `c80dda9`.
- Repo `caelum0x/cred402` → confirmed **public** via `gh repo view`.
- Live API base `https://cred402-1.onrender.com/` → responds `200`.
- Live QIE status endpoint `https://cred402-1.onrender.com/v1/x402/qie/status`
  → responds `200` with `{"configured":false,...,"reason":"CRED402_QIE_PAY_TO is
  required to enable the paid QIE endpoint"}`. This is correct, intended
  behavior, not a bug: the route is deployed and live, but fails closed because
  no real QUSDC contract address or x402 facilitator for QIE has been
  independently confirmed to exist yet (see Known gaps below). It is not
  faking a working paid endpoint.

## What the project does (for the form)

Cred402 is a pay-per-call credit-score API for AI agents, with the score itself
anchored on Casper. An agent calls `GET /v1/x402/qie/credit-score/:agentId`,
gets an HTTP `402 Payment Required` x402-protocol challenge, pays in QUSDC on
QIE, and receives a JSON credit report: score, probability of default, risk
band, eligibility, and reason codes. The same resource is also sold over
Algorand (USDC) and NEAR (native NEAR) rails — QIE is a third, independent
settlement rail reusing the same underwriting engine (`state.x402CreditScore`),
proving the pattern generalizes across chains rather than being a one-off demo.

Every settled QIE payment is anchored into a Casper-rooted "Universal Receipt"
(`api/qie_receipt_anchor.ts`), provisional until an independent re-read of the
QIE RPC's transaction receipt and ERC-20 `Transfer` log confirms it, then
finalized. This is the same anchoring pattern used for the Algorand and NEAR
integrations — Casper is the project's common settlement-proof root across all
chains, not a QIE-specific afterthought.

## Tech stack

- Runtime: Node.js 20+, TypeScript, `tsx` (no build step for dev/test).
- x402 protocol: `@x402/core` (chain-agnostic wire format) + `@x402/evm`
  (`ExactEvmScheme`, since QIE is EVM-compatible: Cosmos SDK consensus,
  standard `eth_*` JSON-RPC).
- QIE-specific code: `lib/x402/qie_gateway.ts` (resource server),
  `lib/x402/qie_networks.ts` (`eip155:1983` testnet / `eip155:1990` mainnet),
  `lib/x402/qie_rpc.ts` + `qie_finality.ts` (independent settlement
  verification directly against QIE RPC — no confirmed Indexer-equivalent
  exists for QIE, so Cred402 reads its own RPC rather than trusting a
  facilitator's report alone), `lib/x402/qie_payment_attempt_store.ts`
  (durable exact-once replay protection).
- HTTP routes: `api/qie_x402_routes.ts` (`/v1/x402/qie/status`,
  `/v1/x402/qie/credit-score/:agentId`, `/v1/x402/qie/payments/:id`),
  `api/qie_receipt_anchor.ts` (Casper anchoring).
- Casper anchoring: `casper-js-sdk`, `@casper-ecosystem/casper-eip-712`.
- Tooling: `scripts/qie_x402_check.ts` (live read-only preflight, never signs
  or pays), `scripts/qie_x402_ready.ts` / `qie_x402_release_check.ts`
  (balance-readiness + signed-evidence artifact, mirroring the Algorand
  parity scripts).
- Frontend console: Vite + React, deployed at `cred402.vercel.app`
  (not QIE-specific, but the same console surfaces every chain integration).
- Deployment: API on Render (`cred402-1.onrender.com`), console on Vercel.

## Test status

450/450 tests passing (`npm test`), `npm run typecheck` clean, re-verified
today, not carried forward from a stale report. QIE-specific coverage:
`test/qie_x402.test.ts`, `test/qie_receipt_anchor.test.ts` (6 tests against a
real `Ledger`), `test/qie_x402_ready.test.ts` (mocked RPC).

## Demo / repo links

- Repo: https://github.com/caelum0x/cred402 (public)
- Live API: https://cred402-1.onrender.com (base responds 200; QIE route live
  and correctly returns `configured: false` until QUSDC contract + facilitator
  are set — see Known gaps)
- Live console: https://cred402.vercel.app
- Integration writeup: `docs/qie_x402.md` (in-repo, full protocol/config/gaps)
- Unpaid challenge, no key needed:
  `curl -i https://cred402-1.onrender.com/v1/x402/qie/credit-score/EvidenceSellerAgent`
  (will 503 until `CRED402_QIE_PAY_TO` etc. are set on the deployment — see
  Known gaps; the route code itself is live and tested, the live deployment's
  env vars are the only gap)

## Known gaps (honest, not hidden)

- `CRED402_QIE_ASSET_ADDRESS` (QUSDC's ERC-20 contract on QIE) was never
  independently confirmed by research — required env var, no default, route
  fails closed with 503 without it.
- `CRED402_QIE_FACILITATOR_URL` — no confirmed public/default x402 EVM
  facilitator for QIE exists yet; needs a self-hosted or third-party one.
- No contract has been deployed to QIE Mainnet (chain 1990); submission
  requires a mainnet contract address per the hackathon's stated requirements.
- No real on-chain QIE transaction has been made (none should be faked —
  `docs/SUBMISSIONS.md` explicitly tracks this as a real-network deliverable
  that can't be simulated).
- No demo video recorded yet.

These three (QUSDC address, facilitator, mainnet deploy) are the actual
blockers to a fully live end-to-end QIE payment — not test coverage or code
completeness, which are both already done.

## Draft project description (paste-ready, ~150 words)

> Cred402 gives AI agents a pay-per-call credit score they can buy over x402 —
> no API key, no subscription, no human in the loop. An agent hits
> `GET /v1/x402/qie/credit-score/:agentId`, gets a standard x402 `402 Payment
> Required` challenge priced in QUSDC on QIE, pays, and gets back a full
> credit report: score, probability of default, risk band, eligibility, and
> reason codes. Every settled payment is independently reconciled against
> QIE's own RPC (no trusted facilitator report taken at face value) and
> anchored into a Casper-rooted receipt that any agent can verify
> on-demand — the same proof-of-settlement root Cred402 uses across its
> Algorand and NEAR integrations. The result: agents that transact with each
> other get a real, chain-verified trust signal to decide whether to extend
> credit, accept a job, or route a payment — and Cred402 proves the model by
> literally selling that signal the same way it expects other agent economy
> APIs to.

## Owner-only steps (not done, needs your login/identity/payment)

1. Log into `hackathon.qie.digital/dashboard/categories` and confirm the real
   current category list (the page is login-gated, could not be scraped from
   here). Plausible guesses based on what cred402 actually does, ranked:
   - **AI & Autonomous Agents** — best fit; this is literally an
     agent-to-agent paid credit API.
   - **DeFi & Financial Infrastructure** — strong secondary fit; it's a
     credit/underwriting primitive.
   - **Developer Infrastructure & Tooling** — plausible if the above two
     don't exist under those exact names; it's x402 payment-rail plumbing.
2. Fill in team lead name, email, team size on the submission form.
3. Confirm/create a QIE wallet address to use as `CRED402_QIE_PAY_TO` and for
   any prize payout.
4. Confirm QUSDC's real ERC-20 contract address on QIE (testnet and mainnet)
   and stand up or point at a working x402 EVM facilitator — both require
   real research/credentials this agent doesn't have.
5. Set the confirmed env vars on the live Render deployment
   (`CRED402_QIE_PAY_TO`, `CRED402_QIE_ASSET_ADDRESS`,
   `CRED402_QIE_FACILITATOR_URL`) so the live demo URL actually pays instead
   of returning 503.
6. Deploy to QIE Mainnet (chain 1990) and record a real transaction hash +
   contract address — needs a funded mainnet wallet.
7. Record a short demo video/screen capture and post it per the hackathon's
   visibility requirement.
8. Submit the form at `hackathon.qie.digital` before **2026-11-30**.

None of the above was done by this agent — all require real login, identity,
or funds.
