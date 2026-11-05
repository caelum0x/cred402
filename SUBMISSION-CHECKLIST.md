# NEAR Hackathon submission checklist (Nov 1-14, 2026, results Nov 18)

Code, docs, tests, and repo visibility are done. What's left is short and
owner-only (identity + a social post + the form submission).

## Done (no action needed)

- [x] NEAR x402 settlement built and tested: `lib/x402/near_*.ts`,
      `api/near_x402_routes.ts`, `api/near_receipt_anchor.ts`.
- [x] Buyer example: `examples/near-paid-score/typescript.ts` (+ README).
- [x] Status/usage/attempt routes: `/v1/x402/near/status`,
      `/v1/x402/near/usage`, `/v1/x402/near/payments/:id`.
- [x] Tests: 14 new (`test/near_x402.test.ts`), full suite 450/450 green
      (re-verified 2026-11-05), `npm run typecheck` clean.
- [x] Real end-to-end NEAR Testnet verification (2026-11-02): live local
      server, real `402`/invalid-proof/underpaid-proof rejections, and one
      genuine on-chain NEAR Testnet payment (tx
      `C1LNxQFEaR2AQj79U9WzToiB1eY86jwzmxoHKvr9W7jk`) settled for real —
      see "Verification" in `docs/near_x402.md`.
- [x] `HACKATHON.md` written (what/why/how-to-run/track/NEAR tools used).
- [x] Repo `caelum0x/cred402` confirmed **public** (`gh repo view` →
      `visibility: PUBLIC`) — already satisfied the hackathon's public-repo
      requirement before this work started; re-verified, no change needed.
- [x] Changes committed and pushed to `origin/main`.
- [x] SpendGuard NEAR smart contract (`contracts-near/spend_guard`) — AI
      Security & Defense complement to the x402 rail above: policy-underwritten
      credit lines, protocol-enforced spend caps via real NEAR Function Call
      Access Key allowances, a dispute-rate circuit breaker, and a real
      revolving-credit `repay_credit_line` + `top_up_allowance` pair.
      18/18 unit tests green. Real `near-workspaces` sandbox test
      (`tests/sandbox.rs`) against a live local nearcore node proves the
      full loop end to end: draw → real on-chain repayment (outstanding
      exposure verified zeroed via `get_exposure` before/after) → real
      on-chain top-up that restores exactly the freed headroom and
      re-mints the SAME still-active key → a real spend that succeeds
      again on that key → dispute spike → freeze → revoked-key rejection
      — see "SpendGuard" section in `HACKATHON.md`.

## Owner-only (fill in before submitting)

1. **Team info** — the hackathon form asks for a team lead name/email and
   team size. This agent does not have and must not guess your identity:
   - Team lead name: `[OWNER: fill in]`
   - Team lead email: `[OWNER: fill in]` (likely `subasiarhan3@gmail.com`,
     but confirm — this is your call, not an automated default)
   - Team size: `[OWNER: fill in]` (solo founder → `1`, unless you're
     entering with others)

2. **NEAR payout account** — if the hackathon asks for a NEAR account to
   receive prize funds, it must be a real wallet you control:
   - Payout NEAR account id: `[OWNER: fill in]`
   - If you don't have one yet: create a free NEAR account at
     [near-faucet.io](https://near-faucet.io) (testnet) or
     [NEAR Wallet](https://wallet.near.org) (mainnet, for a real payout
     account) in under a minute, then fill this in.
   - This is also the account you can optionally set as
     `CRED402_NEAR_PAY_TO` if you want the deployed demo to actually charge
     into your own wallet instead of a disposable test account.

3. **Demo post on X (required, confirmed against the real hackathon page
   2026-11-05)** — must state you built this at NEAR HACKATHON, tag
   `@NEARProtocol` and `#NEARHackathon`, and have a demo video or
   screenshots attached. Fastest path: record a ~60-90s screen capture of
   the "How to run it" steps in `HACKATHON.md` (steps 2-4: status probe,
   402 challenge, one real paid call against NEAR Testnet via
   `examples/near-paid-score/typescript.ts`) or run `npm run
   demo:near-spend-guard` for the SpendGuard revolving-credit loop (draw →
   repay → top up → draw again → freeze, proven live in this repo). This
   needs your logged-in X account, so it's not something this agent can do.
   - Demo video/screenshot link: `[OWNER: fill in]`
   - X/Twitter post URL (must tag @NEARProtocol + #NEARHackathon): `[OWNER: fill in]`

4. **Submit the form** at [nearhackathon.com](https://nearhackathon.com)
   before **Nov 14, 2026 23:59 UTC** (results by Nov 18, 2026 23:59 UTC).
   Confirmed fields on the real form (2026-11-05): project name, team lead
   name + email, team size, track (up to 13 available — pick **Agent
   Economy**), NEAR wallet address for prize distribution, repository link
   (required), demo post link on X (required), a 20-2000 character project
   description (the "What it does" section of `HACKATHON.md`, ~1,100
   chars, pastes in directly), and an optional website URL.
   - Repo URL: `https://github.com/caelum0x/cred402` (public, confirmed)
   - The team info, payout account, and demo link from steps 1-3 above.
   - Submission form confirmation: `[OWNER: fill in once submitted]`

## Not done, and intentionally so

- No real NEAR Mainnet payment was made or claimed. This submission runs
  on NEAR **Testnet** only, per the task's own instruction not to attempt a
  real mainnet payment. `CRED402_NEAR_MAINNET_RELEASE_ACK` gates Mainnet
  and is unset.
- Nothing was posted to X/Twitter and the hackathon form was not submitted
  — both require your logged-in accounts and are listed above as the only
  remaining steps.
