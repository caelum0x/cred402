# Security

Cred402 is hackathon/research software. Do not use it with real funds or real
KYC/lending without an audit. The implemented mitigations are below.

## Implemented mitigations

| Threat | Mitigation in this repo |
| --------------- | ----------------------- |
| Fake x402 revenue / collusion rings | `FraudService` — reciprocal-loop, operator-linkage, revenue-concentration and velocity detection; gates credit underwriting (`lib/services/fraud_service.ts`). |
| Payment replay | Nonce uniqueness per payer + payment-proof dedupe + expiry rejection in `X402ReceiptRegistry` and the Odra contract; `verifyPayment` rejects expired challenges. |
| Falsified RWA evidence | WatchdogAgent cross-checks against an independent source → DisputeCourt → DisputeJudge → SlashingVault. |
| Unauthorized parameter changes | Admin-gated privileged methods in every Odra contract; off-chain governance writes are logged with a public parameter history. |
| Over-exposure / risky draws | `max_agent_exposure` cap, `min_reputation_to_draw` floor, open-dispute draw block, emergency pause flags. |
| Signature forgery | ed25519 verification against the payer's Casper public key on every x402 payment. |

## Reporting

This is a demo repository. For the production protocol, security reports would go
to a dedicated channel with coordinated disclosure.

## Secrets

No secrets are committed. Live Testnet deploys read `CRED402_SECRET_KEY` /
`CRED402_NODE` from the environment (see `scripts/deploy_testnet.ts`). Keep keys
out of source control (`.gitignore` covers `.env`).
