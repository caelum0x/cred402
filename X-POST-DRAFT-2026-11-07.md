# X post draft — Cred402 × NEAR Hackathon (2026-11-07)

Owner-gated: needs your logged-in X account. Copy the caption below, attach
`media/cred402-near-spend-guard-demo.mp4` (or the `.gif`), post, then paste
the resulting URL into `SUBMISSION-CHECKLIST.md` item 3.

Required by the real hackathon rules (confirmed 2026-11-05): state you
built this at NEAR HACKATHON, tag `@NEARProtocol`, use `#NEARHackathon`,
attach a demo video or screenshots. The caption below satisfies all four.

---

## Caption (primary, fits X's limit)

Built Cred402 SpendGuard at NEAR HACKATHON: a real NEAR smart contract
that turns an AI agent's verified x402 revenue into a protocol-enforced
spending limit — nearcore itself caps it via a Function Call Access Key
allowance, not just a contract check.

This clip is a real terminal session against our live public NEAR
Testnet contract (spendguard-024e8dd6f7.testnet): 25 real on-chain spends,
a real repay, a real top-up that re-mints the SAME key, one more real
spend past the original allowance, then a dispute spike → freeze →
rejected call. No staged output — `npm run demo:near-spend-guard`, run on
camera.

@NEARProtocol #NEARHackathon

github.com/caelum0x/cred402

---

## Caption (alternate, shorter)

An AI agent's revolving credit line, enforced by NEAR itself — not an app
check. Real draw → repay → top-up → draw again → freeze, all on-chain
against our live NEAR Testnet contract. Built at NEAR HACKATHON.

@NEARProtocol #NEARHackathon
github.com/caelum0x/cred402

---

## Attachment

- Primary: `media/cred402-near-spend-guard-demo.mp4` (17.0s, 1174x560,
  H.264 — real recorded terminal output, X-upload-ready)
- Alternate (GIF, if X thread prefers): `media/cred402-near-spend-guard-demo.gif`
- Full-fidelity source (not for upload, kept for judges who want to replay
  the exact real session): `media/cred402-near-spend-guard-demo.cast`
  (`asciinema play media/cred402-near-spend-guard-demo.cast`)
