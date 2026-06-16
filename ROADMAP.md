# Cred402 Roadmap

This repo implements the **protocol heart** of the Cred402 production blueprint
(distilled in `PRODUCTION.md`) as working, tested, runnable code, and maps the remaining
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
| ChainAdapter SDK | ✅ `packages/chain-adapters` — CasperAdapter (root) + EvmAdapter/EvmSatelliteVault + CosmosAdapter/CosmosSatelliteVault (CosmWasm, sha256 tx ids) |
| End-to-end omnichain flow | ✅ `npm run demo:multichain` + 5 p3 tests — two satellite families (Base + Osmosis) sharing one Casper-rooted exposure cap (bind → earn → anchor → CAN → lend → repay) |
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

## ✅ Production services & infra — built

| Area | Status |
| ---- | ------ |
| **Compliance service** (§7.9) | ✅ `lib/compliance/` — sanctions screening (subject + OFAC-style jurisdiction lists), jurisdiction lending policy, KYB gate, data-retention policy; wired into `CreditAgent.underwrite`/`explain` (refuses sanctioned operators) + `/v1/compliance/agents/:id` |
| **Go event indexer** (§7.4) | ✅ `services/event-indexer/` — replays the NDJSON journal into agent/pool/dispute projections with a seq checkpoint; `go build`/`go vet` clean; verified against a live journal. `sink.Sink` is the Postgres seam |
| **Casper transport** (live Testnet) | ✅ `lib/casper/` — real `fetch` JSON-RPC client (reads work with no SDK), typed deploy/runtime-arg construction + `casper-client` renderer, `CasperTransport` interface with casper-js-sdk reduced to an injected `DeploySigner`. `npm run casper:health` |
| **Infra** | ✅ `infra/` — multi-stage `Dockerfile` (non-root, healthchecked), `docker-compose.yml` (api + indexer + postgres), Helm chart (`helm lint` clean: deployment/service/ingress/hpa/pvc/secret-ref), cloud-agnostic Terraform module |

## ✅ Production-completion layer — built

| Area | Status |
| ---- | ------ |
| **Production plan** | ✅ `PRODUCTION.md` — full-product plan: surfaces, protocol core, services, security, deployment, launch sequence, doc→code map |
| **OpenAPI 3.1** | ✅ `packages/openapi/cred402.v1.yaml` — all 27 `/v1` operations, envelope + auth + schemas; `redocly lint` clean |
| **GraphQL API** (p2 §7.1) | ✅ `lib/graphql/` — typed read surface (`graphql` ref impl) at `POST/GET /graphql`; agents, pool, analytics, marketplace, search, compliance |
| **Python risk-engine** (p2 §7.6/§7.8) | ✅ `services/risk-engine/` — logistic PD credit model + linear (SHAP-like) reason attribution + Tarjan-SCC fraud graph; HTTP API + CLI, runs live |
| **Casper transport** (live seam) | ✅ `lib/casper/` — `LedgerTransport` (real, executes entry points) + `Ed25519DeploySigner` (real blake2b hash + ed25519 signature + `account_put_deploy`) + JSON-RPC reads. Two working `CasperTransport` impls |
| **4-language SDKs/CLIs** | ✅ `cli/` (TS), `sdk/python`, `sdk/go`, `sdk/rust` — all build + run live |
| **New product APIs/pages** | ✅ analytics/notifications/search services + Analytics & Explorer console pages + notification bell |

## ✅ Product expansion — built

| Area | Status |
| ---- | ------ |
| **Developer portal** (console) | ✅ `frontend/src/components/Developer.tsx` — mint scoped API keys, subscribe webhooks (one-time secrets), live GraphQL console |
| **Agent 360° drill-down** | ✅ `/api/agent-profile/:id` + `/v1/agents/:id/profile` + `AgentDetail.tsx` overlay (passport, credit reason codes, compliance, RealFi, receipts, reputation history); click any leaderboard row |
| **Prometheus `/metrics`** | ✅ `lib/gateway/metrics.ts` — pool/agents/disputes/defaults gauges + per-event counters in exposition format |
| **`@cred402/sdk`** (TS) | ✅ `packages/ts-sdk/` — full typed client (every `/v1` route + GraphQL + idempotency + webhook signature verify) |
| **Python agent orchestrator** | ✅ `services/agent-orchestrator/` — policy engine OUTSIDE the LLM (spending limits, tool permissions, circuit breaker, approval gate), planner, audit log, pure-stdlib Ed25519 for x402; demonstrably **blocks** an over-limit draw |
| **Notification service** | ✅ `services/notification-service/` — multi-channel (console/webhook/Slack/Discord), templates, dedupe + retry, polls the live feed |
| **Webhook receiver example** | ✅ `examples/webhook-receiver/` — verifies HMAC signatures via the SDK; full subscribe→deliver→verify loop confirmed (27/27 verified) |

## ✅ Bureau & gateway depth — built

| Area | Status |
| ---- | ------ |
| **Credit report** (headline bureau artifact) | ✅ `lib/services/credit_report.ts` — FICO-style report (score+band, PD estimate, recommended terms, +/− factors, payment history, public records, inquiries, revenue, compliance); `/v1/agents/:id/credit-report` + `/api/credit-report/:id` + console `CreditReportView` (gauge) in the agent overlay |
| **GraphQL mutations** | ✅ `Mutation` type — registerAgent/openCreditLine/draw/repay/verifyOperator/openDispute; SDL exported via `npm run graphql:sdl` → `packages/graphql/schema.graphql` |
| **Ops / incident board** | ✅ `/api/incidents` + console `Ops` tab — fraud watchlist, frozen/defaulted lines, open disputes, emergency pause switches |
| **x402 playground** | ✅ `/api/x402/buy` + console `x402` tab — runs the real 402→sign→200 flow and visualizes challenge headers + receipt + signed report |
| **Prometheus HTTP metrics** | ✅ `/metrics` now includes `cred402_http_requests_total{route,status}` from the v1 gateway |
| **Pagination + filtering** | ✅ `/v1/agents` (service_type, min_reputation) and `/v1/receipts` (status, seller) support `?limit/offset` — array shape preserved (SDK-compatible) |

## ✅ Functional commerce & live data — built

| Area | Status |
| ---- | ------ |
| **Agent-to-agent marketplace commerce** | ✅ `state.marketplacePurchase` — any agent buys a listed service; records a real facilitator-settled x402 receipt that builds the seller's revenue + reputation (the flywheel). REST (`/api/marketplace/purchase`, `/v1/marketplace/purchase`), console **Buy** button, GraphQL `purchaseListing` mutation |
| **SSE live analytics** | ✅ `/api/analytics/stream` pushes the analytics snapshot on each event (throttled); the Analytics page consumes it — live, no polling |
| **Batch underwriting** | ✅ `/v1/credit/underwrite-batch` — underwrite up to 100 agents in one call with per-item ok/error |
| **CSV export, simulation, status doctor, public HTML report** | ✅ `/api/export/*.csv`, `npm run simulate`, `npm run status`, `GET /report/:id` |

## ✅ Full economic loop driveable from every surface — built

Every step of the protocol's economic cycle is now a real API action (REST `/api`
+ `/v1`, GraphQL mutations, console controls):

| Step | Endpoint(s) |
| ---- | ----------- |
| LP deposit / withdraw | `/v1/credit/deposit`, `/v1/credit/withdraw` (free-liquidity guard) + console buttons |
| Agent register / stake | `/v1/agents`, `/v1/agents/:id/stake` (+`stakeAgent` GraphQL) — stake boosts the credit line |
| Earn (x402 / marketplace) | `/api/x402/buy`, `/api/marketplace/purchase` (+`purchaseListing` GraphQL) |
| Underwrite (single / batch) | `/v1/credit/lines`, `/v1/credit/underwrite-batch` |
| Draw / repay | `/v1/credit/lines/:id/draw`, `/repay` |
| Dispute open / resolve / slash | `/v1/disputes`, `/v1/disputes/:id/verdict` (slashes + reputation hit) + console resolve buttons |

Integrator artifacts: `packages/openapi/cred402.v1.yaml` (OpenAPI 3.1),
`cred402.http` (REST Client), `cred402.postman_collection.json`,
`packages/graphql/schema.graphql` (SDL). Live surfaces: `/graphql` (+`/graphiql`
+`/graphql/stream` live queries), `/api/analytics/stream` (SSE), `/metrics`
(Prometheus incl. HTTP request counts), `/report/:id` (public HTML credit report).

## ✅ DeFi pool, insurance, lifecycle mechanics — built

| Mechanic | Endpoint(s) |
| -------- | ----------- |
| LP positions + pro-rata yield | `/api/lp`, `/v1/credit/lp`, GraphQL `lp` — console LP positions table |
| LP deposit / withdraw | `/v1/credit/deposit` · `/withdraw` (free-liquidity guard) |
| Agent self-listing | `/v1/marketplace/listings`, GraphQL `createListing` — console "List a service" form |
| Insurance claims | `/v1/insurance/claim` — pays from the slashing insurance reserve (dispute slash → 30% reserve → LP claim; reserve guard) |
| Reputation time-decay | `/v1/reputation/decay` (p2 §6.6) — inactive agents drift to a floor |
| Credit-line health + freeze | `/v1/credit/health`, `/v1/credit/lines/:id/freeze` |

The extended `npm run simulate` exercises the entire loop (deposits, staking,
agent-to-agent trading, dispute→verdict→slash→insurance reserve). **39 `/v1`
routes**, 14 console tabs, GraphQL read+write parity.

## ✅ Discovery, trust & multichain depth — built

| Area | Status |
| ---- | ------ |
| **Agent discovery / ranking** | ✅ `lib/services/discovery.ts` — composite buyer-facing score fusing reputation (0.35) + credit (0.25) + web-of-trust (0.20) + tier bonus − fraud penalty, clamped 0..100; filter by `service_type`/`min_reputation`/`min_score`. `/v1/discovery` + console **Discovery** tab (3 tests) |
| **Web of trust (attestations)** | ✅ `lib/services/attestation_graph.ts` — agents vouch for each other with anti-Sybil caps (attester rep ≥ 60, ≤ 6 boost/target, one vouch/pair); `/v1/attestations` (POST) + `/v1/attestations/graph` + per-agent; console **Trust** tab renders the directed graph as SVG |
| **Per-jurisdiction compliance report** | ✅ `lib/services/compliance_report.ts` — operators grouped by jurisdiction with KYB coverage + sanctions exposure; `/v1/compliance/report` + console **Compliance** tab |
| **Reputation tiers** | ✅ `lib/services/reputation_tiers.ts` — bronze→diamond badges with credit-multiplier + origination-discount perks, applied in underwriting; `/v1/agents/:id/tier`, `/v1/tiers` |
| **Cosmos + Solana satellites** | ✅ `packages/chain-adapters/.../{cosmos,solana}` — `CosmosAdapter`/`CosmosSatelliteVault` (CosmWasm, sha256) and `SolanaAdapter`/`SolanaSatelliteVault` (Anchor/SPL, base58 sigs); `npm run demo:multichain` runs **three satellite families** (Base + Osmosis + Solana) under one shared Casper-rooted exposure cap |

| **Credit what-if simulator** | ✅ `lib/services/credit_simulator.ts` — read-only underwriting preview: runs the live risk policy + governance cap against hypothetical signals without mutating state. `POST /v1/credit/simulate` + console Risk-tab panel (4 tests) |
| **Peer benchmark** | ✅ `lib/services/peer_benchmark.ts` — percentile + rank of an agent vs its service-type cohort (reputation/credit/revenue/fraud). `/v1/agents/:id/benchmark` + AgentDetail overlay section (3 tests) |
| **Satellite families: Solana + Move** | ✅ `SolanaAdapter`/`SolanaSatelliteVault` (Anchor/SPL, base58 sigs) and `MoveAdapter`/`MoveSatelliteVault` (Aptos/Sui Move, 0x-hex tx hashes) — four satellite families (EVM/Cosmos/Solana/Move) execute credit against Casper CANs under one shared exposure cap; `demo:multichain` runs Base + Osmosis + Solana |

| **Credit pre-approval offers** | ✅ `lib/services/credit_offers.ts` — time-bounded offer (terms from the live underwriter) → agent accepts to open a line at locked terms, or it expires. `/v1/credit/offers` (issue/list/accept/decline) + console Credit Pool card + MCP tools + `cred402 credit offer/offers/accept/decline` CLI (6 tests) |
| **CLI bureau commands** | ✅ `cred402 credit simulate` (what-if preview) + the offer lifecycle subcommands — the TS CLI reaches the new `/v1` surfaces with human + `--json` output |
| **Agent credit history (credit file)** | ✅ `lib/services/credit_history.ts` — every on-chain event concerning an agent, chronological + categorized (identity/revenue/credit/dispute/reputation/crosschain), built from the canonical event log. `/v1/agents/:id/history` + AgentDetail "History" view + MCP tool (2 tests) |
| **Python SDK parity** | ✅ `sdk/python` — `discovery.search/attest/attestation_graph`, `credit.portfolio/simulate/offers/issue_offer/accept_offer/decline_offer`, `agents.benchmark/history` reach the new bureau surfaces; integrator `.http` collection extended to match |
| **GraphQL parity** | ✅ `lib/graphql` — `discovery/portfolio/attestationGraph/benchmark/creditHistory/scoreTrend/readiness/riskAlerts/yieldProjection/fleetOverview/simulateCredit/creditOffers` queries + `issueCreditOffer/acceptCreditOffer` mutations; every bureau read surface now resolves over GraphQL, SDL re-exported to `packages/graphql/schema.graphql` |
| **Go + Rust SDK parity** | ✅ `sdk/go` (`Discover/Portfolio/AttestationGraph/Benchmark/CreditHistory/SimulateCredit/CreditOffers/IssueCreditOffer/AcceptCreditOffer`) and `sdk/rust` (`discover/attestation_graph/attest/portfolio/benchmark/credit_history/simulate_credit/credit_offers/issue_credit_offer/accept_credit_offer`) reach the new surfaces — verified live; bureau features now have parity across REST, GraphQL, MCP, CLI, and all four SDKs |
| **Risk monitoring alerts** | ✅ `lib/services/risk_alerts.ts` — always-on sweep emitting severity-ranked alerts (concentration breach, overdue lines, fraud exposure on drawn credit, frozen/defaulted lines, liquidity stress). `/v1/risk/alerts` + console Ops-tab card + MCP tool (4 tests) |
| **@cred402/sdk parity** | ✅ `packages/ts-sdk` — `discover/attestationGraph/attest/portfolio/riskAlerts/yieldProjection/benchmark/creditHistory/simulateCredit/creditOffers/issueCreditOffer/acceptCreditOffer/declineCreditOffer`; the new bureau surfaces now reach **all five SDKs** (ts-sdk, Python, Go, Rust, CLI) plus REST/GraphQL/MCP — verified live |
| **LP yield projection** | ✅ `lib/services/yield_projection.ts` — forward LP yield over 30/90/365 days (gross interest, LP share after protocol spread, expected loss, projected net APY); explicitly assumption-driven and kept separate from realized APY. `/v1/credit/yield-projection` + console Credit Pool card + MCP tool (3 tests) |
| **Onboarding readiness scorecard** | ✅ `lib/services/onboarding_scorecard.ts` — pass/fail checklist of every credit gate (reputation, disputes, fraud, compliance, revenue, stake, KYB) with guidance + overall readiness %; mirrors the live underwriter gates. `/v1/agents/:id/readiness` + console Onboard-tab check + MCP tool + ts-sdk (3 tests) |
| **Offer lifecycle events** | ✅ `CreditOfferIssued/Accepted/Declined` now emit on the canonical event bus → fan out to HMAC webhooks, the SSE stream, and the agent's credit history automatically (2 tests) |
| **Bureau integration capstone** | ✅ `test/bureau_integration.test.ts` — one end-to-end test drives offer → accept → draw and asserts history, portfolio, risk alerts, yield projection, readiness and discovery all reflect the same shared ledger |
| **Credit-score & reputation trend** | ✅ `lib/services/score_trend.ts` — reconstructs an agent's score/reputation trajectory (current, net change, points) from the canonical event log. `/v1/agents/:id/score-trend` + AgentDetail sparklines + MCP tool + ts-sdk (3 tests) |
| **`bureau` CLI command group** | ✅ `cli/commands/bureau.ts` — `discover/portfolio/alerts/yield/benchmark/readiness/trend/history` give ops a one-command view of every analytics surface (human + `--json`) |
| **Enriched public credit report** | ✅ `/report/:id` now server-renders trend sparklines (inline SVG, no JS), peer-standing percentile, and credit-readiness alongside the score gauge and reason factors — a complete shareable credit file |
| **Bureau roster CSV export** | ✅ `/api/export/bureau.csv` — analyst-ready roster joining discovery ranking with per-agent credit readiness; download link on the console Discovery tab |
| **Operator fleet overview** | ✅ `lib/services/fleet_overview.ts` — one-call dashboard joining discovery standing + credit readiness + current line for a list of agents (unknown ids flagged). `POST /v1/operators/fleet-overview` + console Ops-tab fleet check + MCP tool + ts-sdk (2 tests) |
| **Credit-line review (ratchet-up)** | ✅ `lib/services/credit_review.ts` — periodic re-underwriting that raises a limit when metrics improve, holds otherwise, and **never auto-reduces** extended credit (reductions stay an explicit freeze). `POST /v1/credit/lines/:id/review` + GraphQL mutation + console Credit Pool "Review" button + MCP tool + ts-sdk (4 tests) |
| **Per-agent cross-chain summary** | ✅ `lib/services/agent_multichain.ts` — one agent's address bindings, Casper-anchored external receipts, and Credit Authorization Notes per satellite chain, plus its shared global exposure. `/v1/agents/:id/multichain` + GraphQL + MCP tool + ts-sdk (3 tests) |
| **Batch line review** | ✅ `state.reviewAllCreditLines` — periodic portfolio maintenance that re-underwrites every active line (ratchet-up only) and summarizes increased/held/ineligible. `POST /v1/credit/review-all` (admin) + MCP tool + ts-sdk (2 tests) |
| **Doctor bureau probes** | ✅ `npm run status` now probes discovery / portfolio / risk-alerts / yield-projection / readiness too — **17/17 surfaces healthy** end-to-end against a live server |
| **Service-category analytics** | ✅ `lib/services/category_analytics.ts` — market intelligence rolled up by service type (agent supply, avg reputation/credit, receipts, revenue, top earner). `/v1/analytics/categories` + GraphQL + MCP tool + ts-sdk (2 tests) |
| **x402 receipt-network stats** | ✅ `lib/services/x402_stats.ts` — Product-B analytics: total volume, settlement-status breakdown, finalization rate, top sellers/payers, per-service volume. `/v1/analytics/x402` + console **Network** tab (20th) + GraphQL + MCP tool + ts-sdk (2 tests) |
| **Go + Rust SDK refresh** | ✅ brought `sdk/go` and `sdk/rust` back to parity with the newest analytics surfaces (benchmark, health, compare, credit-cost, category/reputation/dispute/x402 stats) — both build clean and `gofmt`/`cargo fmt` pass |
| **Protocol config (rulebook)** | ✅ `lib/services/protocol_config.ts` — self-documenting live parameters: fee schedule, credit gates (min reputation, max exposure), and the full reputation-tier perk table. `/v1/config` + console Developer-tab rulebook + GraphQL `config` + MCP tool + ts-sdk (1 test) |
| **Bureau lifecycle demo** | ✅ `npm run demo:bureau` (`scripts/demo_bureau.ts`) — a narrated end-to-end walk: readiness → what-if → offer → accept → draw cost → health → benchmark → compare → trend → multichain → protocol analytics. Living documentation + smoke test against a live server |
| **`bureau` CLI refresh** | ✅ added `health/market/x402/disputes/config` subcommands so the CLI reaches every analytics surface (human + `--json`) |
| **Deploy/dev fixes** | ✅ added `frontend/src/vite-env.d.ts` (types `import.meta.env` for the deployed cross-origin `streamUrl` config — unblocks `tsc -b`/Vercel build) and extended the Vite dev proxy to `/v1`·`/graphql`·`/report`·`/metrics` so every bureau surface works under `npm run dev` |
| **Dispute statistics** | ✅ `lib/services/dispute_stats.ts` — protocol-level dispute intelligence (totals, open/resolved, outcomes by verdict & type, total slashed, resolution + agent-loss rates, most-disputed agent). `/v1/analytics/disputes` + console Disputes-tab stats card + GraphQL + MCP tool + ts-sdk (2 tests) |
| **Reputation movers** | ✅ `lib/services/reputation_movers.ts` — biggest net reputation gainers/losers reconstructed from the event log (momentum, not just level). `/v1/analytics/reputation-movers` + GraphQL + MCP tool + ts-sdk (3 tests) |
| **Market section (console)** | ✅ the Analytics tab now renders the per-category market table and reputation-mover chips alongside the live leaderboard and trends |
| **Webhook delivery log** | ✅ `WebhookService` keeps a 200-entry ring buffer of delivery attempts (delivered/failed, http status, retries); `GET /v1/webhooks/deliveries` (admin, filterable by subscription) + ts-sdk — integrators can debug their webhook endpoints (3 tests) |
| **Credit cost calculator** | ✅ `lib/services/credit_cost.ts` — borrower transparency for a specific draw: upfront origination fee + prorated interest over the line's remaining term + total repayment + effective all-in cost, with headroom guard. `/v1/agents/:id/credit-cost?draw_cspr=` + GraphQL + MCP tool + ts-sdk (4 tests) |
| **Similar agents recommender** | ✅ `lib/services/similar_agents.ts` — "you might also consider": same-category peers ranked by closeness in standing (reputation + credit) and overall discovery strength. `/v1/agents/:id/similar` + AgentDetail "see also" section + GraphQL + MCP tool + ts-sdk (3 tests) |
| **Agent health badge** | ✅ `lib/services/agent_health.ts` — a glanceable green/amber/red verdict (worst-of reputation, fraud risk, open disputes, credit-line status) with a composite score + driving factors; distinct from credit-readiness gates. `/v1/agents/:id/health` + AgentDetail header chip + GraphQL + MCP tool + ts-sdk (4 tests) |
| **Agent comparison** | ✅ `lib/services/agent_compare.ts` — buyer-facing side-by-side of two agents across discovery/reputation/credit/trust/revenue/fraud/dispute with per-metric + overall winners (lower-is-better metrics invert). `/v1/agents/compare?a=&b=` + console Discovery "Compare" panel + GraphQL + MCP tool + ts-sdk (3 tests) |
| **Sign-in with Casper Wallet** | ✅ real browser-extension integration (`frontend/src/lib/casperWallet.ts`, `hooks/useCasperWallet.ts`, `WalletButton` with Connect → Sign in → ✓) + backend `lib/services/wallet_auth.ts` — challenge → wallet ed25519 signature → server-side `@noble/curves` verification → one-time-nonce session. `POST /v1/auth/wallet/challenge` + `/verify`, and `GET /v1/auth/wallet/agents` returns the account's owned agents ("my agents"). No private key ever leaves the extension (6 tests) |

**63 `/v1` routes**, 19 console tabs, 27 MCP tools, 34 OpenAPI paths, 66 tests.

## 🔭 Remaining (designed, not yet coded here)

- **Go ports of the relayer/proof-service** (p3 §relayers) — the relay→prove→anchor
  path is implemented and tested in TypeScript (`crosschain/`); Go binaries are packaging.
- **Python risk/fraud ML port** (§7.6, §7.8) — deterministic risk policy + graph
  `FraudService` are in TS; the ML scoring variant is an advisory upgrade.
- **GraphQL API** (§7.1) — REST `/v1` + webhooks + API keys are built; GraphQL is an optional projection.
- **Live deploy signer** — the casper-js-sdk `DeploySigner` implementation (serialize + sign) is the one remaining seam to submit to Testnet; reads + deploy construction are done.

## Path to mainnet

1. Deploy the 8 Odra contracts to Testnet; replace the ledger simulation with
   `casper-js-sdk` calls behind the same interfaces.
2. Stand up the Go indexer against CSPR.cloud streaming events.
3. Add governance timelock + launch multisig.
4. Add the Python risk/fraud services as advisory inputs to `RiskPolicyManager`.
5. Security audit (see the threat model in `SECURITY.md`) before mainnet.
