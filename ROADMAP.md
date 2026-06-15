# Cred402 Roadmap

This repo implements the **protocol heart** of the Cred402 production blueprint
(`docs/p2.md`) as working, tested, runnable code, and maps the remaining
production-operations scaffolding as roadmap. Honesty about what is and isn't
built matters more than empty stub files.

## ✅ Built and verified (this repo)

| Blueprint area | Status |
| -------------- | ------ |
| **Agent Passport** (Product A) | ✅ `lib/ledger/contracts/agent_passport.ts`, `/api/passport/:id`, dashboard |
| **x402 Receipt Network** (Product B) | ✅ real 402→sign→200 flow, on-chain receipt commitments |
| **RWA Evidence Graph** (Product C) | ✅ evidence registry + asset registry, linked to receipts |
| **Agent Credit Pool** (Product D) | ✅ deposit/open/draw/repay/liquidate, fees, health factor |
| **Dispute / Slashing / Governance** (Product E) | ✅ DisputeCourt + SlashingVault + Governance + DisputeJudgeAgent |
| **Reputation Engine** (§6.6) | ✅ multi-dimensional, on-chain composite score |
| **Risk Policy Manager** (§6.8) | ✅ upgradable v1→v2, governance-bound |
| **Agent system** (§8) | ✅ Buyer, Seller, Credit, Treasury, Watchdog, DisputeJudge, LiquidityRouter |
| **MCP server** (§12) | ✅ 16 tools + 6 resources over stdio JSON-RPC (`mcp/`) |
| **TypeScript SDK** (§4) | ✅ `sdk/` Cred402Client (REST + x402 + SSE) |
| **API Gateway (REST + SSE + x402)** (§7.1–7.2) | ✅ `api/` zero-dep node:http |
| **Console / dashboard** (§3) | ✅ Vite + React, 6 tabs, live event feed |
| **Casper contracts (Odra/Rust)** (§6) | ✅ 14 Odra crates under `contracts/` (registry, passport, x402 receipts, RWA asset + evidence, reputation, credit pool, risk policy, dispute court, slashing vault, governance + p6 fiat-receipt / operator-verification / realfi-attestation) — all compile; 11 unit-tested |
| **Event model** (§13) | ✅ streaming events → SSE → watchdog + dashboard |
| **Tests** | ✅ 45 `node:test` cases (`test/`) + 39 Odra contract tests across all 11 Casper crates, run in the OdraVM via `cd contracts && cargo test` (no WASM/testnet needed) |

## ✅ p3 omnichain layer (Casper-rooted, chain-executed) — built

| Blueprint area | Status |
| -------------- | ------ |
| Cross-chain standards (CAID/ABE/URE/UAID/EAE/CAN) | ✅ `crosschain/standards` — real dual-sig (ed25519+secp256k1), blake2b ids, JSON schemas + validator |
| AddressBindingRegistry | ✅ dual-signature-verified bindings (`lib/ledger/contracts/address_binding_registry.ts`) |
| ExternalReceiptRegistry | ✅ anchors non-Casper x402 receipts; reputation settles on Casper |
| GlobalExposureManager | ✅ per-agent cap across all chains — the over-borrow guard |
| CreditAuthorizationNotes | ✅ short-lived Casper-policy-signed CANs; reserve exposure on issue |
| UpgradeManager | ✅ contract versions + upgrade history |
| ChainAdapter SDK | ✅ `packages/chain-adapters` — CasperAdapter (root) + EvmAdapter + EvmSatelliteVault |
| End-to-end omnichain flow | ✅ `npm run demo:multichain` + 4 p3 tests (bind → earn → anchor → CAN → lend → repay) |
| Satellite contracts (EVM/Solana/Cosmos/Move/Bitcoin) | ✅ `contracts/{evm,solana,cosmos,move,bitcoin}` |
| Casper-root relayer + proof service | ✅ `crosschain/relayers` (event→proof→anchor) + `crosschain/proof-service` (signed blake2b Merkle batch + inclusion proofs). Wired into `npm run demo:multichain` and tested in `test/relayer.test.ts` |
| Real RWA data | ✅ Open-Meteo solar + PV physics model (`api/rwa_data`) — no mock |
| Real crypto | ✅ `@noble/curves` secp256k1, `@noble/hashes` keccak256/blake2b |

Phases 1–7 of the p3 expansion sequence are represented: Casper core (p1/p2),
address bindings, external receipt anchoring, evidence mirrors, Casper-issued
credit notes, satellite credit vaults, and the global agent credit market.

## ✅ p4 fraud & attack hardening (§13) — built

| Attack (p4 §13) | Mitigation status |
| --------------- | ----------------- |
| 1 — wash receipts | ✅ `FraudService`: reciprocal-loop + operator-linkage graph detection, revenue concentration, velocity, and off-market **pricing-band** anomaly (`lib/services/fraud_service.ts`) |
| 2 — Sybil agent swarm | ✅ operator identity graph — flags one operator controlling ≥3 agents |
| 5 — credit pool drain | ✅ `AgentCreditPool` exposure caps + freeze/liquidate + `GlobalExposureManager` |
| 6 — cross-chain double borrow | ✅ Casper-issued CAN + exposure reservation before any satellite draw |
| 7 — relayer lies | ✅ `ProofService` signed Merkle batch + inclusion proofs; relayer keys allowlisted before anchor |

The fraud score gates underwriting (`econ.credit.underwrite` refuses high-fraud
agents); tested in `test/protocol.test.ts`.

## ✅ p4 economics/marketplace/trust-ladder + p5 reason codes — built

| Blueprint area | Status |
| -------------- | ------ |
| **Marketplace** (p4 §18) | ✅ `lib/services/marketplace.ts` — full 16-category taxonomy, 7 pricing strategies (fixed/dynamic/auction/subscription/reputation-tiered/urgency/data-cost-plus), trust-enriched listings ranked by reputation |
| **Protocol economics / fee model** (p4 §11) | ✅ `lib/core/economics.ts` — facilitator/origination/late fees, 10% interest spread, 50/25/25 slash route, honest LP `poolHealth` (realized APY + risk flags, no fake APY) |
| **Trust ladder Stage 2** (p4 §26) | ✅ `crosschain/trust-ladder/multi_relayer.ts` — bonded multi-relayer quorum + challenge window + fraud-proof bond slashing |
| **Trust ladder Stage 3** | ✅ `crosschain/trust-ladder/finality.ts` — per-chain confirmation + time finality policy |
| **Trust ladder Stage 4** | ✅ `crosschain/trust-ladder/proof_types.ts` — pluggable proof-type registry (`merkle` + `threshold` real; `light_client`/`zk` honestly rejected until built) |
| **Credit reason codes** (p5 §15) | ✅ `lib/core/reason_codes.ts` — 14 structured positive/negative codes derived from on-chain signals, attached to every credit decision and shown in `npm run demo` |
| Demo | ✅ `npm run demo:marketplace` (marketplace + economics + trust ladder); reason codes in `npm run demo` |

## ✅ p6 RealFi Bridge — built

| Blueprint area | Status |
| -------------- | ------ |
| **RealFi envelopes** (FRE/OVE/BVE) | ✅ `lib/realfi/envelopes.ts` — privacy-preserving (hashes only, PII never on-chain), blake2b commitments + validators |
| **FiatReceiptRegistry** (p6) | ✅ `lib/ledger/contracts/fiat_receipt_registry.ts` + Odra `contracts/fiat_receipt_registry` — Stripe-equivalent of the x402 receipt, provider-event idempotency |
| **OperatorVerificationRegistry** | ✅ TS + Odra crate — Stripe-Identity-style operator KYB attestations |
| **RealFiAttestationRegistry** | ✅ TS + Odra crate — generic bank/cashflow/chargeback/sanctions attestations |
| **RealFi Bridge service** | ✅ `lib/services/realfi_bridge.ts` — turns Stripe/Plaid payloads into hashed on-chain envelopes |
| **RealFi credit scoring** (p6 §864) | ✅ `lib/services/realfi_credit.ts` — bounded ±uplift (operator/fiat/bank/chargeback), capped so fiat never dominates Casper-native receipts; wired into `CreditAgent` + reason codes |
| Surfaces | ✅ wired end-to-end: REST (`GET /api/realfi`, `POST /api/demo/realfi`, `/api/realfi/verify-operator`/`fiat-receipt`/`chargeback`), 3 MCP tools (19 total), console **RealFi** tab, and `npm run demo:realfi` (anonymous → verified +uplift → chargeback cut, zero PII on-chain) |
| **EVM RealFi mirror** (Solidity) | ✅ `contracts/evm/src/Cred402RealFiMirror.sol` — mirrors fiat receipt + operator-verification commitments on EVM (emits for the Casper-root relayer); wired into `Deploy.s.sol`; compiles under Foundry (`via_ir` now default) |

## ✅ p7 §9/§11 — built

- `THIRD_PARTY.md` (§9) — honest open-source attribution + originality boundary.
- `npm run ship:check` (§11) — `scripts/ship_first_check.ts` reports the ship-first stack status against the repo (7 integrated · 4 own-impl · 1 transport-swap pending).

## ✅ Console surfacing (p4 §11/§18, p5 §15)

- **Credit Pool tab** — click a credit line to see its structured reason codes (`/api/credit/explain/:id`) + a Protocol Economics panel (honest realized APY, fees, loss rate, risk flags via `/api/economics`).
- **Marketplace tab** — trust-ranked agent service listings (`/api/marketplace`).

`THIRD_PARTY.md` (p7 §9) records the open-source rails used vs. the protocol Cred402 owns.

## ✅ Production API gateway (p2 §7.1) — built

The hackathon server is now a real service. `lib/gateway/` + the versioned `/v1`
API (`api/v1/router.ts`) add the production concerns the console-facing `/api/*`
routes lacked:

| Concern | Status |
| ------- | ------ |
| Config + fail-fast secrets | ✅ `config.ts` — typed env config; refuses to boot on mainnet/auth without required secrets |
| Structured logging | ✅ `logger.ts` — JSON logs, level gate, secret redaction, request-scoped child loggers |
| Error envelope | ✅ `errors.ts` — typed `ApiError`s → stable codes/status; one `{success,data\|error,request_id}` shape |
| Input validation | ✅ `validation.ts` — composable, dependency-free schema parser at every boundary (no blind `as`) |
| API keys + scopes | ✅ `api_keys.ts` — hashed storage, constant-time verify, read/write/admin scopes |
| Rate limiting | ✅ `rate_limit.ts` — per-identity token bucket |
| Idempotency | ✅ `idempotency.ts` — `Idempotency-Key` replay protection on mutations |
| Webhooks | ✅ `webhooks.ts` — HMAC-signed delivery + retry/backoff, fanned from the event bus |
| Durable persistence | ✅ `persistence.ts` — append-only NDJSON event journal (`CRED402_DATA_DIR`) + atomic snapshots; replaces in-memory-only |

`/v1` routes for agents, receipts, credit (pool/lines/draw/repay/explain),
economics, marketplace, disputes, realfi, and admin (api-keys, webhooks) — each
authenticated, rate-limited, validated, and enveloped. The console keeps the
unversioned `/api/*` routes.

## 🔭 Production scaffolding (designed, not yet coded here)

These are part of the blueprint but are infrastructure/ops concerns that a
hackathon vertical slice intentionally defers. They are specified in
`docs/p2.md`; this repo provides the protocol they would wrap.

- **Live Testnet deploy** — `scripts/deploy_testnet.ts` prints the casper-client
  plan + manifest; wiring `casper-js-sdk` in place of `lib/ledger` is a transport
  swap (the method surface is identical).
- **Go ports of the relayer/proof-service** (p3 §relayers) — the relay→prove→anchor
  path is implemented and tested in TypeScript (`crosschain/`); the Go service
  variants (per-chain relayer binaries, standalone proof-service) are deployment
  packaging, not new protocol logic.
- **Go event indexer** (§7.4) — CSPR.cloud / Sidecar → Postgres/ClickHouse. The
  durable NDJSON journal (`lib/gateway/persistence.ts`) is the system of record it
  would consume; the Go projection workers remain to be packaged.
- **Python risk/fraud ML port** (§7.6, §7.8) — the deterministic risk policy and
  graph-based `FraudService` (p4 §13) are implemented in TS; the Python ML scoring
  variant is an advisory upgrade, not missing protocol logic.
- **GraphQL API** (§7.1) — REST `/v1` (auth, rate limits, validation, idempotency),
  webhooks and API keys are built; a GraphQL projection of the same data is optional.
- **Compliance service** (§7.9) — KYC/KYB, sanctions screening, disclosures.
- **Infra** — Terraform, Helm/K8s, the full `.github/workflows/*` matrix.
- **EVM mirror adapters** (optional, §5) — cross-chain only, not core Casper logic.

## Path to mainnet

1. Deploy the 8 Odra contracts to Testnet; replace the ledger simulation with
   `casper-js-sdk` calls behind the same interfaces.
2. Stand up the Go indexer against CSPR.cloud streaming events.
3. Add governance timelock + launch multisig.
4. Add the Python risk/fraud services as advisory inputs to `RiskPolicyManager`.
5. Security audit (see `docs/p2.md` §14 threat model) before mainnet.
