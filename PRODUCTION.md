# Cred402 — Production Plan & System of Record

> **Cred402 is the Casper-rooted credit bureau for autonomous AI agents.** Agents
> earn through x402, prove their work through on-chain receipts and RWA evidence,
> build reputation, and borrow working capital from DeFi pools — across every
> chain, with Casper as the canonical root of identity, reputation, receipts, and
> credit policy.

This document is the production plan: what the full product is, what is built,
how it is operated, and the sequence to mainnet. It is the index that ties the
design to running code.

> The protocol was seeded by a series of design notes. Their substance now lives
> in the polished docs under `docs/` (architecture, risk model, x402 flow,
> protocol/, whitepaper/) plus the real-integration phase docs `docs/p8.md`
> (Casper Testnet), `docs/p9.md` (x402 + data + MCP), and `docs/p10.md` (RealFi +
> cross-chain). Inline `(pN §X)` citations in source comments are provenance
> markers pointing back at those original notes.

---

## 1. Product surface (what a customer touches)

| Surface | Audience | Status |
| ------- | -------- | ------ |
| **Console** (`frontend/`) | LPs, operators, analysts | ✅ 19 tabs: Analytics, Onboard, Agents, RWA Jobs, Receipts, Credit Pool, Marketplace, Discovery, x402, Risk (incl. credit what-if simulator), Disputes, Governance, Multichain, RealFi, Trust, Compliance, Explorer, Developer, Ops + notification bell + **Casper Wallet connect** (real extension provider) |
| **Public REST API `/v1`** | integrators | ✅ auth (scoped API keys), rate limiting, validation, idempotency, envelope; OpenAPI 3.1 (`packages/openapi/cred402.v1.yaml`) |
| **GraphQL API `/graphql`** | dashboards / typed clients | ✅ `lib/graphql/` — typed query surface over the same read models |
| **MCP server** (`mcp/`) | AI agents | ✅ 32 tools — zero-dep stdio (`mcp/server.ts`) **and** official `@modelcontextprotocol/sdk` transport (`mcp/server_sdk.ts`, p9) for Claude Desktop / MCP Inspector |
| **SDKs** | developers | ✅ TypeScript (`sdk/`), Python (`sdk/python/`), Go (`sdk/go/`), Rust (`sdk/rust/`) |
| **CLIs** | developers / ops | ✅ `cred402` in TS (`cli/`), Go, Rust |
| **x402 paid endpoints** | agent-to-agent commerce | ✅ real `402 → sign → 200` flow with **real EIP-712 typed-data digests** (`@casper-ecosystem/casper-eip-712`); optional real `casper-x402` facilitator settlement (`api/paid_evidence_server`, `lib/x402`) |
| **Risk service API** | underwriting | ✅ Python risk-engine (`services/risk-engine/`) — PD model + fraud graph |

## 2. Protocol core (the canonical layer — Casper)

Implemented as **14 Odra (Rust→Wasm) contracts** in `contracts/`, each with a
faithful in-memory mirror in `lib/ledger/contracts/` (the transport seam):

AgentRegistry · AgentPassport · X402ReceiptRegistry · RWAAssetRegistry ·
RWAEvidenceRegistry · ReputationEngine · AgentCreditPool · RiskPolicyManager ·
DisputeCourt · SlashingVault · Governance · FiatReceiptRegistry ·
OperatorVerificationRegistry · RealFiAttestationRegistry.

Cross-chain (p3): standards (CAID/ABE/URE/UAID/EAE/CAN, `crosschain/standards`),
satellite contracts (`contracts/{evm,solana,cosmos,move,bitcoin}`), the
Casper-root relayer + Merkle proof-service (`crosschain/`), and the trust ladder
(`crosschain/trust-ladder`: multi-relayer + finality + proof-types).

## 3. Off-chain services

| Service | Lang | Path | Role |
| ------- | ---- | ---- | ---- |
| API gateway | TS | `api/`, `lib/gateway/` | `/v1` + console `/api` + GraphQL; auth, rate limit, validation, idempotency, webhooks, structured logs |
| Durable persistence | TS | `lib/gateway/persistence.ts` | append-only NDJSON event journal (system of record) + atomic snapshots |
| Event indexer | Go | `services/event-indexer/` | replays the journal → agent/pool/dispute projections (checkpointed) |
| Risk engine | Python | `services/risk-engine/` | logistic PD credit model + Tarjan-SCC fraud graph; advisory inputs to RiskPolicyManager |
| Compliance | TS | `lib/compliance/` | sanctions + jurisdiction + KYB + data-retention; gates underwriting |
| RealFi bridge | TS | `lib/services/realfi_bridge.ts`, `lib/realfi/{stripe,plaid}.ts` | **real** Stripe test-mode webhooks (HMAC-verified) + Plaid sandbox → privacy-preserving on-chain envelopes (p10) |
| Casper transport | TS | `lib/casper/` | JSON-RPC reads + **byte-exact `casper-js-sdk` deploy signer + WASM installer** (p8) + **Sidecar SSE event feed** (`casper-network/casper-sidecar`); `CRED402_CHAIN=sim\|testnet` switch |

## 4. Security model

- **Secrets**: env-driven, validated and fail-fast at boot (`lib/gateway/config.ts`). The API refuses to start on testnet/mainnet without required secrets.
- **AuthN/Z**: scoped API keys (read/write/admin), SHA-256 hashed at rest, constant-time verify (`lib/gateway/api_keys.ts`).
- **Abuse**: per-identity token-bucket rate limiting; idempotency keys on mutations.
- **Boundary validation**: every request body parsed by a typed schema (`lib/gateway/validation.ts`) — no blind casts.
- **Privacy**: no PII on-chain (p6) — fiat/identity data committed only as hashes (`lib/realfi/envelopes.ts`); logs redact secret-like fields.
- **Webhooks**: HMAC-signed with timestamped, replay-resistant signatures.
- **On-chain invariants**: replay protection on receipts/CANs, global exposure cap (cross-chain over-borrow guard), dispute-gated credit, slashing.
- **Cross-chain trust**: launch at Stage 1 (trusted relayer w/ public logs), designed through Stage 4 (zk) — proof types honestly reject unsupported verification.

## 5. Data & observability

- **System of record**: the event journal (NDJSON), consumed by the Go indexer into projections; a real DB writer implements the same `sink.Sink` interface.
- **Logging**: structured JSON, level-gated, request-scoped (`lib/gateway/logger.ts`).
- **Health**: `GET /v1/health` (liveness/readiness); `npm run casper:health` probes the chain node.
- **Analytics**: live read model (`lib/services/analytics.ts`) — TVL, utilization, throughput, leaderboard, credit timeline.

## 6. Deployment

`infra/`: multi-stage non-root `Dockerfile` (healthchecked), `docker-compose.yml`
(api + indexer + postgres), Helm chart (`helm lint` clean), and a cloud-agnostic
Terraform module. All runtime config is environment-driven; state persists to a
`CRED402_DATA_DIR` volume.

## 7. Launch sequence (testnet → mainnet)

1. **Deploy contracts to Casper Testnet** — ✅ real path built (p8): `scripts/deploy_testnet.ts` installs the Odra WASM via the byte-exact `casper-js-sdk` signer when `CRED402_CHAIN=testnet` + key are set, else prints the casper-client plan. Live reads verified against `node.testnet.casper.network` (Casper 2.0). Build WASM, fund a key, run it.
2. **Stand up the indexer** against the live journal / CSPR.cloud sidecar.
3. **Enable auth + webhooks**; mint scoped keys; register integrator webhooks.
4. **Wire the risk engine** as an advisory input to RiskPolicyManager (it already scores live agents).
5. **Compliance go-live** — load the real sanctions/jurisdiction lists; require KYB for credit above a threshold.
6. **Cross-chain**: Stage 1 trusted relayer → Stage 2 multi-relayer with bonds.
7. **Governance**: timelock + launch multisig before mainnet credit; legal/operating model per the RealFi compliance boundary (`docs/p10.md`) before real fiat flows.

## 8. Open seams (honest)

- **Casper deploy signer** — ✅ closed in p8: byte-exact `casper-js-sdk` signer + WASM installer (`lib/casper/sdk_signer.ts`, `install.ts`), offline-tested in `test/casper_sdk.test.ts`. Remaining live-only step is funding a Testnet key and resolving installed contract hashes from account named keys.
- **DB-backed indexer sink** — the Go `sink.Sink` interface is ready; a Postgres writer is packaging.
- **Go relayer binaries** — the relay→prove→anchor path is implemented and tested in TS; Go ports are deployment packaging, not new logic.

## 9. Design lineage → code coverage map

The protocol was seeded by design notes p1–p7 (now removed from the tree; their
substance is distilled into the polished `docs/` and this file). p8–p10 are the
live "make it real" phase docs that replace simulation/mocks with real rails.

| Theme (origin) | Where it lives |
| -------------- | -------------- |
| the idea + demo loop (p1) | `npm run demo`, `agents/`, `api/` |
| production protocol + services (p2) | `contracts/`, `lib/`, `api/`, `mcp/`, `frontend/`, `lib/gateway/`, `lib/compliance/`, `services/`, `packages/openapi/` |
| omnichain, Casper-rooted (p3) | `crosschain/`, `contracts/{evm,solana,cosmos,move,bitcoin}`, `packages/chain-adapters/` |
| fraud, marketplace, economics, trust ladder (p4) | `lib/services/fraud_service.ts`, `marketplace.ts`, `lib/core/economics.ts`, `crosschain/trust-ladder/` |
| reason codes, Agent Finance (p5) | `lib/core/reason_codes.ts`, the credit decision path |
| RealFi Bridge (p6) | `lib/realfi/`, `lib/services/realfi_bridge.ts`, RealFi registries + EVM mirror |
| direct-use stack, attribution (p7) | `THIRD_PARTY.md`, `npm run ship:check` |
| **Real Casper Testnet (`docs/p8.md`)** | `lib/casper/`, `scripts/deploy_testnet.ts`, `deploys.testnet.json` |
| **Real x402 + data + MCP (`docs/p9.md`)** | `lib/x402/facilitator.ts`, `api/rwa_data/`, official MCP SDK in `mcp/` |
| **Real RealFi + cross-chain (`docs/p10.md`)** | `lib/services/realfi_bridge.ts`, Stripe/Plaid adapters, Base Sepolia deploy + relayer |

See `ROADMAP.md` for the per-feature build ledger.
