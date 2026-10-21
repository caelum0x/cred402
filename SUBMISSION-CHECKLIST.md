# NEAR Hackathon submission checklist (Nov 1-14, 2026, results Nov 18)

Code, docs, tests, and repo visibility are done. What's left is short and
owner-only (identity + a social post + the form submission).

## Done (no action needed)

- [x] NEAR x402 settlement built and tested: `lib/x402/near_*.ts`,
      `api/near_x402_routes.ts`, `api/near_receipt_anchor.ts`.
- [x] Buyer example: `examples/near-paid-score/typescript.ts` (+ README).
- [x] Status/usage/attempt routes: `/v1/x402/near/status`,
      `/v1/x402/near/usage`, `/v1/x402/near/payments/:id`.
- [x] Tests: 14 new (`test/near_x402.test.ts`), full suite 450/450 green,
      `npm run typecheck` clean.
- [x] `HACKATHON.md` written (what/why/how-to-run/track/NEAR tools used).
- [x] Repo `caelum0x/cred402` confirmed **public** (`gh repo view` →
      `visibility: PUBLIC`) — already satisfied the hackathon's public-repo
      requirement before this work started; re-verified, no change needed.
- [x] Changes committed and pushed to `origin/main`.

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

3. **Demo video or screenshots** — the hackathon wants proof it runs. The
   fastest path: record a ~60-90s screen capture of the "How to run it"
   steps in `HACKATHON.md` (steps 2-4: status probe, 402 challenge, one
   real paid call against NEAR Testnet via
   `examples/near-paid-score/typescript.ts`). Post it to X/Twitter
   (required by most NEAR Hackathon tracks for visibility) — this needs
   your logged-in account, so it's not something this agent can do.
   - Demo video/screenshot link: `[OWNER: fill in]`
   - X/Twitter post URL: `[OWNER: fill in]`

4. **Submit the form** at [nearhackathon.com](https://nearhackathon.com)
   before **Nov 14, 2026 23:59 UTC**. You'll need:
   - Repo URL: `https://github.com/caelum0x/cred402` (public, confirmed)
   - Track: **Agent Economy** (see `HACKATHON.md` for the one-line pitch)
   - A short project description — the "What it does" section of
     `HACKATHON.md` can be pasted in directly or trimmed.
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
