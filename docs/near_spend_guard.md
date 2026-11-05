# NEAR SpendGuard — capped, protocol-enforced agent spending

NEAR Hackathon 2026 (nearhackathon.com), tracks **AI Security & Defense**
(primary) and **Agent Economy** (secondary). This is new work built inside
the Nov 1–14 window; it extends, but does not modify, the pre-existing
NEAR x402 payment rail (`docs/near_x402.md`, commit `c80dda9`, dated Oct 21
— treat that as pre-existing project infrastructure, not hackathon output).

```text
earn (x402 revenue, existing rail)
  -> policy (contracts-near/spend_guard/src/policy.rs)
  -> global exposure reservation (exposure.rs)
  -> a real NEAR Function Call Access Key, allowance = credit line (spend_key.rs)
  -> the agent pays through that key (lib.rs::spend_to_seller)
  -> a dispute-rate spike freezes exposure AND revokes the key (scam_detection.rs)
```

Cred402 already scores an agent's creditworthiness from its real, verified
x402 revenue (the existing risk engine, `lib/core/risk_policy.ts` /
`contracts/risk_policy_manager` on Casper). SpendGuard is the missing piece:
turning that score into a spending permission an agent cannot exceed,
enforced by NEAR itself rather than application code.

## Contract (`contracts-near/spend_guard/`)

A new, separate Rust workspace member — `contracts/Cargo.toml`'s existing
Casper/Odra members are untouched.

- **`policy.rs`** — `policy_v1`, ported 1:1 from
  `contracts/risk_policy_manager/src/lib.rs` (Casper/Odra) to `near-sdk-rs`.
  `credit_line = base_limit(revenue_30d) * stake_mult * dispute_penalty *
  accuracy_mult`, all multipliers in basis points. **Real bug caught and
  fixed before shipping**: Casper denominates `stake` in motes (1 CSPR =
  10^9 motes); NEAR denominates every native amount in yoctoNEAR (10^24
  per NEAR). Porting Casper's `1_000_000_000` divisor unchanged against a
  yoctoNEAR stake doesn't floor to zero — it overshoots by 15 orders of
  magnitude and silently saturates `stake_mult` at its 20000bps ceiling for
  virtually any real stake, regardless of actual amount. Fixed with a
  `YOCTO_PER_NEAR` constant; a regression test
  (`stake_multiplier_uses_yocto_near_not_the_casper_cspr_divisor`)
  reproduces the bug's actual wrong output and asserts the fix. A second
  test cross-checks the ported `credit_line` formula numerically against
  `test/risk_policy.test.ts`'s `policyV1` fixture once CSPR/NEAR unit
  scales are aligned 1:1 — they match exactly.
- **`exposure.rs`** — `ExposureBook`, a fresh Rust port (no prior Rust
  crate existed) of `lib/ledger/contracts/global_exposure_manager.ts`'s
  `GlobalExposureManager`: `ensure_agent` / `reserve_exposure` /
  `activate_exposure` / `release_reservation` / `decrease_exposure` /
  `freeze_agent_exposure`, same semantics (refuses to exceed the cap,
  freeze is a hard stop).
- **`spend_key.rs`** — mints/revokes the real NEAR primitive: a Function
  Call Access Key, `allowance` = the approved credit line, scoped to call
  only `spend_to_seller` on this same contract. See the module's own doc
  comment for why the live key is added to the **contract's own account**
  rather than the agent's identity sub-account — NEAR only permits
  `AddKey`/`DeleteKey` as same-account self-actions outside of an account's
  own creation batch, so a parent contract cannot reach back into a
  sub-account it created earlier and delete a key on it later. The identity
  sub-account (`agent-<id>.<spendguard-root>.testnet`) is still created and
  funded for every agent — it is the human-readable "sandboxed wallet"
  identity; the enforcement lives on the contract account for protocol
  reasons.
- **`scam_detection.rs`** — the circuit breaker. `record_dispute_spike`
  accumulates a per-agent dispute count; crossing `DISPUTE_SPIKE_THRESHOLD`
  (3) freezes `ExposureBook` and returns a real `delete_key` `Promise` for
  that agent's live key, independent of remaining allowance.
- **`lib.rs`** — ties it together: `new(admin)`, `request_spend_authorization`
  (admin-only — see below), `spend_to_seller`, `repay_credit_line`,
  `top_up_allowance`, `report_dispute_spike`, `emergency_freeze`, and views
  (`get_agent`, `get_exposure`, `get_dispute_count`, `remaining_allowance`).
  `repay_credit_line` + `top_up_allowance` (added 2026-11-05) are the
  revolving-credit pair: an admin-verified repayment reduces an agent's
  outstanding exposure, and `top_up_allowance` re-reserves exactly that
  freed headroom and re-mints the SAME still-active spend key with a fresh
  allowance — so an agent draws, repays, tops up, and draws again on one
  continuously-live key instead of a one-shot budget.

### A real protocol constraint that shaped the design

An early version of `spend_to_seller` took an **attached deposit** (the
obvious design: let the Function Call key's allowance cap how much NEAR the
agent can transfer). Tested live — first against a local nearcore sandbox,
then confirmed again against real NEAR Testnet — this is rejected outright:

```text
InvalidAccessKeyError(DepositWithFunctionCall)
```

Function Call Access Keys can **never** attach a deposit to their one
permitted action, regardless of allowance size; the allowance only ever
covers prepaid **gas**. `spend_to_seller` was corrected to take `amount` as
a plain argument: the yoctoNEAR cap is enforced by `ExposureBook` (an
application-level check, exactly the plan's own documented fallback — "the
Function Call Key allowance as an additional, not sole, enforcement
layer"), while the NEAR actually transferred comes out of the contract's
own pooled balance via a separate `Promise::new(seller_id).transfer(...)`.
The FC key's allowance still does real, protocol-level work: it caps how
many authorized calls the key can make (via prepaid gas), and nearcore
refuses the call outright — before this contract's code ever runs — once
that budget is spent, or once the key is deleted.

### `request_spend_authorization` is admin-only

`metrics` is caller-supplied and the call spends out of the contract's own
pooled balance (funding the identity sub-account). Without an admin gate,
any caller could self-declare fake revenue/accuracy and mint itself a
funded spend key. In production, the operator (cred402's backend) would
call this only after independently verifying the agent's real x402 revenue
server-side (reading `near_payment_attempt_store.ts`'s finalized receipts).

### A second real protocol constraint, found building `top_up_allowance`

The obvious way to "raise" an existing Function Call Access Key's allowance
looked like calling `AddKey` again with the new, higher allowance. Tested
live against the same local nearcore sandbox: nearcore unconditionally
rejects this —

```text
ActionError::AddKeyAlreadyExists
```

`AddKey` only ever creates a key; there is no "update an existing key's
allowance" action in the NEAR protocol. `top_up_allowance` instead issues
`delete_key` then `add_access_key_allowance` **in the same receipt**
(`spend_key::retop_spend_key`) — both same-account self-actions, which
nearcore always applies atomically and in order, so the key is never
actually absent from any other transaction's point of view.

## Real verification

**Local, deterministic, zero manual steps** — `cargo test` inside
`contracts-near/spend_guard/`:

- 18 Rust unit tests (policy math, exposure caps including the
  repay-then-reserve-again revolving-credit case, circuit breaker, key
  minting/rejection) — all pass.
- `tests/sandbox.rs`: a real `near-workspaces` sandbox test against a
  genuinely running local nearcore node (not mocked) — deploys the real
  compiled wasm, authorizes an agent, makes 38 real `spend_to_seller`
  calls, gets a real nearcore `InvalidAccessKeyError(NotEnoughAllowance)`
  rejection on the 39th, repays the full outstanding draw with a real
  `repay_credit_line` call (`get_exposure` verified zeroed before/after),
  tops it back up with a real `top_up_allowance` call that restores exactly
  the freed headroom and re-mints the SAME still-active key, makes one more
  real `spend_to_seller` call on that key that succeeds past the point its
  original allowance was exhausted, authorizes a second agent, confirms its
  key works, simulates a dispute spike, freezes it, and gets a real
  nearcore `InvalidAccessKeyError(AccessKeyNotFound)` rejection on the next
  call — passes.

One command: `npm run demo:near-spend-guard` builds the contract, runs the
full test pass above, and then (if a real deploy exists) runs a bonus live
loop against NEAR Testnet.

**Real NEAR Testnet deploy** (`npm run near:spend-guard:deploy`, driven by
`near-api-js` — `cargo near create-dev-account` / `deploy ...
sign-with-keychain send` are both interactive-only, confirmed in this
plan's own pre-work rehearsal):

- Contract account: `spendguard-024e8dd6f7.testnet`.
- Deploy + `new({admin})` init transactions both returned `SuccessValue`,
  independently re-confirmed with a raw `call_function` RPC request against
  `rpc.testnet.near.org` (`admin()` view returns the correct account id).
- A real agent (`demo-buyer-<timestamp>`) was authorized with a 1 NEAR
  30-day revenue input, got a real `credit_line` of `300000000000000000000000`
  yoctoNEAR (0.3 NEAR) back from the live contract, and made **25/25 real
  on-chain `spend_to_seller` calls**, each one a genuine signed transaction
  executed by nearcore and settled.
- A second real agent was authorized, then frozen via
  `report_dispute_spike`; the next call from its key was rejected with a
  real `"Access key ... does not exist"` RPC error — the circuit breaker,
  confirmed live, not simulated.

**Re-verified 2026-11-05** after adding `repay_credit_line` + `top_up_allowance`:
the same live contract account was upgraded in place (`npm run
near:spend-guard:redeploy` — a `DeployContract` action only replaces code,
never storage, so every prior agent/exposure record survived) and the full
revolving-credit loop was proven against the real public network: a fresh
agent made 25/25 real `spend_to_seller` calls, a real `repay_credit_line`
call zeroed its outstanding exposure, a real `top_up_allowance` call
restored exactly that headroom and re-minted its SAME original key, and
one more real `spend_to_seller` call succeeded on that key — all genuine
signed Testnet transactions, not a replay of the sandbox test. A second
agent was frozen exactly as before. **A real, judge-relevant side finding
from this run**: NEAR's own legacy public RPC (`rpc.testnet.near.org`) now
rejects most calls with `-429 "WARNING! THIS ENDPOINT IS DEPRECATED!"` —
every default RPC URL in this repo now points at FastNear's free public RPC
(`rpc.testnet.fastnear.com`) instead; `CRED402_NEAR_RPC_URL` still overrides.

## Known gaps / next pass

- **Day 8 (Chain Signatures)** and **Day 9 (console UI)** — explicitly
  cosmetic/stretch per the plan's own cut lines; not built this pass.
- **Day 7 / 13 (final docs polish, `HACKATHON.md` + `SUBMISSION-CHECKLIST.md`
  updates for both tracks)** — this file covers the architecture writeup;
  the submission-checklist files themselves are a follow-up.
- **Day 12 (demo video recording) and Day 14 (submission form, X post)** —
  owner-only steps, not attempted here.
- A genuine "sandboxed wallet" where the spending key itself lives on the
  agent's own sub-account (rather than the contract's account) would need a
  second, tiny self-revoking contract deployed to each sub-account — a real
  architecture, not a stub, but out of this pass's time budget.
- `repay_credit_line` and `top_up_allowance` (2026-11-05) close the
  draw→repay→top-up→draw-again loop end to end, proven live in
  `tests/sandbox.rs` — no longer a gap.
