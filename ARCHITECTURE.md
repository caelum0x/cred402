# Cred402 — Enterprise Architecture & Growth Plan

> **Status:** Planning document. Grounded in a read of the live codebase
> (`lib/`, `api/`, `crosschain/`, `contracts/`, `services/`, `frontend/`).
> No source was modified to produce this. Where the doc proposes structure that
> does not exist yet, it is marked **(target)**; everything else describes what
> is in the repo today.

---

## 1. What it is + current state

### 1.1 One sentence

Cred402 is a **multi-chain credit & reputation protocol for the x402 economy**:
it ingests x402 machine-to-machine payment receipts from **any chain** (Casper,
Algorand, EVM today), turns each verifiable cash-flow event into **on-chain
reputation**, and underwrites **DeFi working-capital credit lines** for the
autonomous agents that earned them. Identity → payment rails → reputation →
credit. RWA verification is the first demand wedge, not the whole product — the
same loop underwrites any agent that earns through x402.

The product thesis in one line: **DeFi was built for wallets; Cred402 is built
for workers** — it turns agents from tools into financeable economic actors.

### 1.2 Live surfaces

| Surface | Where | State |
|---|---|---|
| Console (React/Vite, 34 components) | `frontend/` → cred402.vercel.app | Live |
| API (hand-rolled Node HTTP + `/v1` gateway) | `api/` → Render (`cred402-1.onrender.com`) | Live |
| Casper contract suite (14 Odra/Rust crates) | `contracts/` | Deployed to Casper **Testnet** (`deploys.testnet.json`, 2026-06-17) |
| Algorand x402 credit oracle | `lib/x402/algorand_gateway.ts` | Live paid endpoint, testnet/mainnet gated |
| MCP server (83 tool entries) | `mcp/` | Live |
| SDKs (TS, Python, Go, Rust) | `sdk/`, `packages/ts-sdk` | Published-shape, in-repo |

### 1.3 Stack

- **Runtime:** Node ≥20, TypeScript (ESM), `tsx`. No web framework — the HTTP
  server in `api/server.ts` (1,117 LOC) is hand-rolled; the `/v1` surface adds a
  small router with idempotency, rate limits, API keys, and webhooks
  (`lib/gateway/`).
- **Contracts:** Odra v2 (Casper Wasm), 14 crates; EVM satellites via Foundry
  (`contracts/evm/`).
- **x402:** Coinbase/`@x402` v2 stack (`@x402/core`, `@x402/avm`, `@x402/fetch`,
  `@x402/extensions`), `casper-x402` facilitator client, `casper-eip-712` for
  typed-data signing.
- **Chains:** `casper-js-sdk`, `@algorandfoundation/algokit-utils` + AlgoNode
  indexer, `@noble/curves`/`@noble/hashes` for EVM/secp256k1 bindings.
- **Polyglot services:** Python risk-engine (`services/risk-engine/` — fraud
  graph + PD model), Go event-indexer (`services/event-indexer/`), Python
  agent-orchestrator (`services/agent-orchestrator/`), TS notification-service.
- **RealFi:** Stripe + Plaid (real test-mode HMAC/sandbox) → on-chain fiat
  receipts.
- **API extras:** GraphQL (`graphql-js`) with an SSE stream and GraphiQL,
  Prometheus `/metrics`, CSV/HTML report exporters.
- **Infra:** `render.yaml`, `infra/Dockerfile`, `infra/docker-compose.yml`,
  Helm chart (`infra/helm/cred402`), Terraform (`infra/terraform`).

### 1.4 The real modules (grounded)

**x402 flows — `lib/x402/`**
- `x402.ts` — the core challenge/authorization/proof protocol: `402` →
  signed `PaymentChallenge` → EIP-712 `PaymentAuthorization` → `X-Payment`
  header → `verifyPayment` → receipt commitment.
- `eip712.ts` / `keys.ts` — casper-eip-712 typed-data digest, ed25519 agent
  identities, signature verification.
- `gateway.ts` — **the adoption wedge**: framework-agnostic middleware (Express
  + Fetch adapters) that makes any route x402-payable *and* receipt-generating,
  with replay-protected nonce/proof stores. Every wrapped endpoint feeds the
  credit-data moat.
- `facilitator.ts` — client to the canonical Casper x402 facilitator
  (verify/settle).
- `algorand_gateway.ts` (Algorand x402 v2 resource server via `@x402/avm` +
  Bazaar discovery), `algorand_client.ts`, `algorand_finality.ts`,
  `algorand_readiness.ts`, `algorand_release.ts`, `algorand_payment_attempt_store.ts`
  — a full, finality-aware, mainnet-gated USDC payment path with reconciliation.
- `evm.ts` — secp256k1 EVM address bindings.
- `external_receipt_proof_store.ts` — persistence for cross-chain receipt proofs.

**Multi-chain adapters — `packages/chain-adapters/`**
- `core/ChainAdapter.ts` interface + adapters for `casper/`, `evm/`, `solana/`,
  `cosmos/`, `move/`, `flare/` (each with a `SatelliteVault`). Flare adapter has
  `fdc.ts`, `ftso.ts`, `fassets.ts`, `networks.ts`.

**Cross-chain provenance — `crosschain/`**
- `standards/receipts.ts` — **Universal Receipt Envelope (URE)**:
  `receipt_id = blake2b256(canonical_json(URE))`, chain-agnostic, anchored to
  Casper. Also `identity.ts`, `bindings.ts`, `evidence.ts`, `credit_notes.ts`,
  `validate.ts` + JSON Schemas in `crosschain/schemas/`.
- `proof-service/` (merkle + proof service), `relayers/casper_root_relayer.ts`,
  `trust-ladder/` (finality, proof types, multi-relayer) — the "how much do we
  trust this cross-chain receipt" ladder.

**Credit / reputation engine**
- `lib/core/` — domain types (`Agent`, `Receipt`, `CreditLine`, `RevenueEvent`,
  the `EventName` union), `risk_policy.ts` (hot-swappable `policyV1`/`policyV2`
  underwriting functions), `economics.ts` (fee schedule, slash routing, honest
  realized-APY pool health — "no fake APY"), `reason_codes.ts`,
  `service_categories.ts`.
- `lib/ledger/` — a **faithful in-memory simulation of the 22 on-chain
  contracts** (`contracts/*` mirror). `ledger.ts` wires `AgentRegistry`,
  `X402ReceiptRegistry`, `AgentCreditPool`, `RiskPolicyManager`, `DisputeCourt`,
  `SlashingVault`, `Governance`, `ReputationEngine`, `AgentPassportRegistry`,
  the p3 omnichain set (`AddressBindingRegistry`, `ExternalReceiptRegistry`,
  `GlobalExposureManager`, `CreditAuthorizationNotes`), and the p6 RealFi set.
  An `EventBus` + `Clock` give it a Casper-streaming-events analogue.
- `agents/` — the autonomous economy: `credit_agent.ts` (**the underwriter** —
  reads receipt history, runs fraud + compliance + RealFi + reputation, opens
  the line), `treasury_agent.ts`, `liquidity_router_agent.ts`,
  `watchdog_agent.ts`, `dispute_judge_agent.ts`, `evidence_seller_agent.ts`,
  `buyer_agent.ts`.
- `lib/services/` (67 files) — the read/analytics layer: `fraud_service.ts`
  (receipt-graph collusion/Sybil detection), `reputation_breakdown.ts`,
  `reputation_decay.ts`, `reputation_tiers.ts`, `credit_oracle.ts`,
  `credit_simulator.ts`, `credit_offers.ts`, `peer_benchmark.ts`,
  `similar_agents.ts`, `agent_dossier.ts`, `attestation_graph.ts`, and the
  cross-chain/RealFi/marketplace surfaces.
- `services/risk-engine/` (Python) — `fraud_graph.py`, `credit_score.py`,
  `features.py`: the ML probability-of-default model and graph fraud analysis
  as a separable service.

### 1.5 Honest maturity

| Dimension | Reality |
|---|---|
| Protocol design | **Strong.** URE, EIP-712 x402, trust ladder, reason codes, honest-APY economics are thoughtfully specified. |
| Casper contracts | **Testnet-deployed**, not mainnet. 14 Odra crates installed 2026-06. |
| "On-chain" logic | Most credit/reputation logic runs in the **in-memory `lib/ledger` simulation**, not on-chain. It is architected as a drop-in for live calls, but the swap is not done. |
| Algorand x402 | **Most production-real path.** Real `@x402/avm` v2 resource, GoPlausible facilitator, USDC 0.01 pricing, finality reconciliation, explicit mainnet ack gate. |
| EVM / Solana / Cosmos / Move adapters | Interfaces + satellite scaffolds; not all live. |
| Data persistence | Largely in-memory + NDJSON journal (`events.ndjson`) + gateway persistence. No production database. |
| Tests | **Heavy** — 69 test files, ~7.2K LOC, parity/protocol/multichain coverage. |
| Licensing | **No `LICENSE` file.** Blocking for the OSS/standard play (see §5). |
| Capital / LPs | Simulated pool. No real pooled capital, no default history, no regulatory posture yet. |

**Bottom line:** an unusually complete, well-tested *reference implementation
and console* of a multi-chain agent-credit protocol, with one genuinely live
paid endpoint (Algorand x402 score). The gap to enterprise is **persistence,
on-chain finalization, real capital, and productization of the data layer** —
not protocol design.

---

## 2. Target enterprise structure

The repo is already ~62K LOC across `lib/`, `services/`, `contracts/`,
`frontend/`, `packages/`. The refactor is **not a rewrite** — it is drawing the
open-core boundary (§5) as a package boundary and extracting the in-memory
ledger into a persisted service. Proposed monorepo (pnpm/turbo workspace):

```
cred402/
├─ packages/                         # OSS core (Apache-2.0) — the protocol
│  ├─ protocol/                      # ← extract lib/core + crosschain/standards
│  │  ├─ src/types/                  #   Agent, Receipt, CreditLine, events
│  │  ├─ src/ure/                    #   Universal Receipt Envelope + canonical id
│  │  ├─ src/x402/                   #   challenge/auth/proof, eip712, keys
│  │  ├─ src/reason-codes/
│  │  └─ src/economics/              #   fee schedule, slash route, honest APY
│  ├─ gateway/                       # ← lib/x402/gateway.ts + lib/gateway
│  │  ├─ src/core/                   #   framework-agnostic middleware
│  │  ├─ src/adapters/express/
│  │  ├─ src/adapters/fetch/
│  │  ├─ src/adapters/fastify/       #   (target)
│  │  └─ src/stores/                 #   nonce/idempotency/persistence ifaces
│  ├─ chain-adapters/               # already exists — keep & harden
│  │  └─ src/adapters/{casper,evm,algorand,solana,cosmos,move,flare}/
│  ├─ trust-ladder/                  # ← crosschain/proof-service + trust-ladder
│  ├─ reputation-ref/                # reference scoring (policyV1/V2, dimensions)
│  ├─ mcp/                           # ← mcp/  (agent-facing tool server)
│  └─ sdk-{ts,python,go,rust}/       # ← sdk/ + packages/ts-sdk
│
├─ services/                         # Commercial data/credit layer (proprietary)
│  ├─ underwriting-api/              # ← api/ + agents/credit_agent  (the /v1 API)
│  │  ├─ src/routes/                 #   split api/server.ts (1.1K) by domain
│  │  ├─ src/underwrite/             #   merge-owner: fraud+compliance+realfi+policy
│  │  └─ src/oracle/                 #   x402 credit-score resource (Algorand+)
│  ├─ bureau-graph/                  # THE MOAT: persisted reputation graph
│  │  ├─ src/ontology/               #   §3 entity/relation/event schema
│  │  ├─ src/ingest/                 #   receipt → graph edges w/ time+provenance
│  │  ├─ src/query/                  #   GraphRAG / dossier / peer-benchmark
│  │  └─ src/fusion/                 #   agent/address/operator entity resolution
│  ├─ risk-engine/                   # already exists (Python) — PD + fraud graph
│  ├─ event-indexer/                 # already exists (Go) — chain → journal → graph
│  ├─ facilitator/                   # hosted x402 verify/settle (SLA tier)
│  ├─ pool-manager/                  # LP capital, exposure, honest-APY accounting
│  ├─ compliance/                    # ← lib/compliance + realfi connectors
│  ├─ notification-service/          # already exists
│  └─ agent-orchestrator/            # already exists (Python task-graph runner)
│
├─ contracts/                        # on-chain (open — needs a license)
│  ├─ casper/                        # ← 14 Odra crates
│  └─ evm/                           # Foundry satellites
│
├─ apps/
│  ├─ console/                       # ← frontend/  (React/Vite)
│  └─ docs/                          # ← docs/ (roadmap, risk model, x402 flow)
│
├─ infra/                            # Docker, Helm, Terraform (exists)
├─ examples/                         # gateway + agent recipes (exists)
└─ tests/                            # ← test/ (69 files) split per package
```

**Key moves:**
1. **Draw the OSS/commercial seam as `packages/` vs `services/`** — the seam is
   already latent (protocol vs. data). Formalize it so `packages/*` can be
   published under Apache-2.0 and `services/bureau-graph` + `services/pool-manager`
   stay proprietary.
2. **Split the two 1K+ LOC files** (`api/server.ts`, `api/state.ts`) into
   `services/underwriting-api/src/routes/*` by domain (agents, receipts, credit,
   disputes, realfi, x402). Per the coding-style rule: many small files.
3. **Extract `lib/ledger` into `services/bureau-graph` with real persistence** —
   this is the single biggest maturity move. The in-memory contracts become the
   write-through cache in front of Postgres + a property-graph store (§3).
4. **Contract finalization path** — wire `lib/ledger` writes to
   `lib/casper/*` + `chain-adapters` so receipts/scores actually anchor.

---

## 3. Graph engineering — Cred402 IS a reputation knowledge graph

Cred402 is not "a product that has a graph" — its core asset **is** a knowledge
graph: cross-agent, cross-chain payment reputation with time and provenance on
every edge. The receipt chain *is* the provenance chain. This section applies
the graph-engineering discipline (ontology → extraction → fusion; task graph)
to what the code already models.

### 3.1 Competency questions (the spec AND the test suite)

1. What is agent X's creditworthiness right now, and which factors drive it?
2. Which receipts underpin X's trailing-30-day revenue (the base of the line)?
3. On which chains has X earned, and are those addresses **provably bound** to X?
4. Is X's revenue concentrated in one counterparty or operator swarm
   (wash/Sybil)? — `fraud_service.ts` answers this today via the receipt graph.
5. What is the full provenance of receipt R: request → signed authorization →
   settlement tx → canonical id → Casper anchor?
6. Which disputes affect X's reputation, and by how much?
7. What is X's credit lifecycle over time: score set → line opened → drawn →
   repaid / defaulted → reputation updated?
8. Which operator controls X, and are its RealFi/fiat signals verified?
9. What was X's reputation **at time T**? (temporal query)
10. Which agents are most similar to X, for peer benchmarking?

Every one of these paths cleanly through the schema below — which is the test
that the ontology is complete.

### 3.2 Ontology (entities)

Representation choice per the modeling reference: a **property graph** (default
for products/agent memory), served from Postgres + Apache AGE or an embedded
Kùzu store, with **time + provenance mandatory on every edge**.

| Entity | Def (from code) | Canonical key |
|---|---|---|
| `Agent` | An x402-earning autonomous actor (`lib/core/types.ts:Agent`) | `agent_id` |
| `Operator` | The human/org controlling one or more agents (passport) | `operator_id` |
| `Address` | A chain address bound to an agent (`AddressBindingRegistry`) | `caip10` (`chain:addr`) |
| `Chain` | A settlement network (`origin_chain`, CAIP-2) | `caip2` |
| `Receipt` | A Universal Receipt Envelope — one x402 payment | `receipt_id` (blake2b256(URE)) |
| `PaymentProof` | The signed EIP-712 authorization behind a receipt | `payment_proof_hash` |
| `ServiceCategory` | `<family>.<name>` risk-weighted category | `service_type` |
| `Evidence` | RWA/work attestation linked to a receipt | `evidence_id` |
| `RwaJob` / `RwaAsset` | Demand-side job / financeable asset | `rwa_id` |
| `Dispute` | A challenge against a receipt/agent (`DisputeCourt`) | `dispute_id` |
| `CreditLine` | Revolving line opened in the pool | `agent_id`+`opened_at` |
| `CreditOffer` | Pre-approved offer | `offer_id` |
| `ReputationScore` | Multi-dimensional score snapshot (temporal) | `agent_id`+`t` |
| `CreditScore` | Underwriting score snapshot (temporal) | `agent_id`+`t` |
| `LiquidityPool` | LP capital backing lines | `pool_id` |
| `Attestation` | RealFi verification (Stripe/Plaid/operator) | `attestation_id` |
| `CreditNote` | Cross-chain credit authorization (`CreditAuthorizationNotes`) | `note_id` |

Attribute-vs-entity calls made deliberately: `ServiceCategory`, `Chain`,
`Operator` are entities (they have their own edges and are queried across
agents); `amount`, `confidence`, `interest_rate_bps` are attributes.

### 3.3 Relations (precise verbs, domain → range, with time + provenance)

```
Agent      CONTROLLED_BY      Operator        {since; provenance: passport sig}
Agent      BOUND_TO           Address         {since; provenance: binding signature}
Address    ON_CHAIN           Chain           {}
Agent      EARNED             Receipt         {t=created_at}          # as seller
Agent      PAID               Receipt         {t=created_at}          # as payer
Receipt    PROVEN_BY          PaymentProof    {provenance: eip712 digest + sig}
Receipt    SETTLED_ON         Chain           {provenance: settlement_tx_hash}
Receipt    ANCHORED_TO        Chain(Casper)   {provenance: external_receipt anchor}
Receipt    CATEGORIZED_AS     ServiceCategory {}
Receipt    CHALLENGED_BY      Dispute         {t}
Evidence   ATTESTS            RwaJob          {confidence}
Evidence   LINKED_TO          Receipt         {}
Agent      HAS_REPUTATION     ReputationScore {t; provenance: ReputationUpdated}
Agent      HAS_CREDIT_SCORE   CreditScore     {t; provenance: CreditScoreSet}
Agent      HOLDS              CreditLine      {opened_at}
CreditLine FUNDED_BY          LiquidityPool   {}
CreditLine DREW/REPAID/DEFAULTED (events)     {t; provenance: deploy_hash}
Operator   VERIFIED_BY        Attestation     {t; provenance: Stripe/Plaid ref}
Agent      PAID ⟲ Agent       (reciprocal)    # fraud signal, not a modeled type
```

Discipline applied: precise verbs (`SETTLED_ON`, `CONTROLLED_BY` — never
`RELATED_TO`); domain/range validated in code (a `BOUND_TO` from Chain → Agent
is rejected); reciprocal `PAID`↔`PAID` loops are **not** a first-class relation
but a graph *query* (`fraud_service.ts` already computes reciprocal
counterparties + operator-swarm size + top-counterparty share).

### 3.4 The provenance chain (the receipt chain IS provenance)

This is the defensible core. Each receipt carries an unbroken, hash-linked
provenance path — retrofitting this after the fact is impossible, which is
exactly why it is a moat:

```
request_hash                     (what was asked)
  → PaymentAuthorization         (EIP-712 typed data the payer signed)
  → payment_proof_hash           (blake2b256 of the signed proof)
  → settlement_tx_hash           (settled on origin chain — Algorand/EVM/Casper)
  → receipt_id = blake2b256(URE) (canonical, chain-agnostic identity)
  → ANCHORED_TO Casper           (ExternalReceiptRegistry root)
  → RevenueEvent                 (feeds trailing-30-day revenue)
  → CreditScore / CreditLine     (underwriting output, with reason codes)
```

Every score Cred402 sells is **explainable back to signed, on-chain payments**.
That is the difference between a credit bureau and a vibe.

### 3.5 Event-logic graph (事理图谱 — "what leads to what")

The `EventName` union in `lib/core/types.ts` is already an event ontology.
Modeled as first-class event nodes with typed arguments (not flattened to edge
soup), it becomes a causal/temporal graph over the credit lifecycle:

```
ReceiptRecorded ─▶ ReceiptFinalized ─▶ CreditScoreSet ─▶ CreditLineOpened
      │                                                        │
      └▶ ReceiptDisputed ─▶ DisputeVerdictIssued ─▶ StakeSlashed ─▶ ReputationUpdated
                                                                        │
CreditDrawn ─▶ (overdue) ─▶ CreditDefaulted ─▶ ReputationUpdated ─▶ CreditFrozen
```

This powers "what caused this agent's score to drop" and forward-looking
"a default here will freeze these downstream lines" — genuinely useful for both
the console and LP risk management.

### 3.6 Extraction & fusion

Match method to source structure (per the extraction reference — do **not**
NLP structured data):
- **Structured (99% of Cred402):** receipts, events, contract state, Stripe/Plaid
  responses → **direct deterministic mapping** to ontology types. No LLM.
  The `event-indexer` (Go) already streams events → journal; extend it to write
  graph edges with time+provenance.
- **Semi-structured:** RWA evidence blobs, weather/solar API (Open-Meteo) →
  per-source parsers → `Evidence` nodes.
- **Unstructured (narrow):** only dispute free-text / KYB documents warrant an
  LLM extraction pass with the ontology in-prompt and an evidence-quote
  requirement.
- **Fusion (the hard part):** entity resolution across chains — the same real
  operator behind agents on Casper + Algorand + Base. Canonical-form rules:
  `Address` keyed by CAIP-10; `Agent` unified via signed `BOUND_TO` edges (never
  by heuristic address clustering alone — that is a fraud vector). Keep
  un-modeled but recurring relations in a `candidate_relations` side-list
  reviewed before promotion.

### 3.7 The score→credit task graph (the diamond pattern)

`CreditAgent.underwrite()` is already a task graph — make it explicit. The
independent factors fan out (they never read each other's results — deleting the
"fake edges" lets them run in parallel), a **separate verifier context** applies
governance invariants, and a **single merge owner** produces the line:

```
                 ┌─ revenue aggregation (trailing-30-day) ─┐
                 ├─ fraud/collusion graph (receipt graph) ─┤
 ingest(agent) ──┼─ compliance / sanctions screen ─────────┼─▶ VERIFY ─▶ MERGE ─▶ line
                 ├─ RealFi signal (Stripe/Plaid/operator) ──┤   (gov      (Credit
                 ├─ reputation compute (6 dimensions) ──────┤    invariants) Agent)
                 └─ tier / peer-benchmark ──────────────────┘
```

- **Verify node (non-negotiable, separate context):** governance invariants —
  `reputation ≥ min_reputation_to_draw`, no open dispute, fraud < 70, compliance
  cleared, exposure ≤ `max_agent_exposure`. A model/agent must not grade its own
  underwriting; the policy check is the skeptic.
- **Merge owner:** `CreditAgent.underwrite` is the single owner of the merge —
  exactly the stop-rule prescription (uncoordinated agents amplify errors;
  one coordinator owning the merge cuts it). Do not distribute the merge.
- **Human gate on irreversible edges:** open line / draw funds / **mainnet USDC
  settlement**. The code already has one:
  `ALGORAND_MAINNET_RELEASE_ACK = "I_ACKNOWLEDGE_REAL_USDC_MAINNET_PAYMENTS"`.
  Route pool draws and any real-money transfer through explicit approval; keep
  scoring (reversible, read-only) gate-free.
- **Guardrails:** loop caps on reconciliation retries; one writer per graph node
  (the indexer owns edge writes); routing lives in code, agents fill the jobs.

---

## 4. OSS foundations

Best-in-class permissive OSS to build on, with license + fit. **Prefer adopting
proven rails over hand-rolling** (the repo already does this well; the notes
below are what to keep, add, or swap).

### 4.1 Already used — keep

| Library | License | Fit |
|---|---|---|
| `@x402/core`, `@x402/avm`, `@x402/fetch`, `@x402/extensions` | **Apache-2.0** | The x402 v2 protocol rails. Core dependency; correct choice. |
| `make-software/casper-x402` (facilitator) | **Apache-2.0** | Canonical Casper facilitator client. |
| `@casper-ecosystem/casper-eip-712` | **Apache-2.0** | Real EIP-712 typed-data — interoperable signing. |
| `casper-js-sdk` | **Apache-2.0** | Byte-exact Casper deploys. |
| `odradev/odra` | **MIT** | Casper Wasm contract framework (14 crates). |
| `@algorandfoundation/algokit-utils` (+ `algosdk`) | **MIT** | Algorand x402 path. |
| `@noble/curves`, `@noble/hashes` | **MIT** | Audited secp256k1/ed25519/blake2b. Best-in-class; keep. |
| `@modelcontextprotocol/sdk` | **MIT** | Agent-facing tool server. |
| `graphql-js` | **MIT** | GraphQL surface. |
| `stripe`, `plaid` (SDKs) | **MIT** | RealFi connectors (the SDKs; the services are commercial). |
| `foundry-rs/foundry` + `forge-std` | **Apache-2.0 / MIT** | EVM satellites. |

### 4.2 Recommended additions

| Need | Library | License | Why |
|---|---|---|---|
| EVM client (replace raw noble usage in adapters) | **viem** | **MIT** | Modern, typed, tree-shakeable; better than ethers for new adapter code. `ethers` (MIT) acceptable fallback. |
| Input validation at boundaries | **Zod** | **MIT** | Replace hand-rolled `lib/gateway/validation.ts`; schema-derived types (matches the coding rules). |
| HTTP framework | **Fastify** or **Hono** | **MIT** | Replace the 1.1K-LOC hand-rolled server; Hono if you want edge/Workers portability. |
| Property-graph store | **Kùzu** (embedded) or **Apache AGE** (Postgres ext) | **MIT / Apache-2.0** | The bureau graph. Kùzu for embedded/analytical; AGE to keep one Postgres. |
| Time-series (score/revenue history) | **TimescaleDB** | **Apache-2.0** (core) | Temporal reputation queries. ⚠ hosted/enterprise features are TSL — self-host the Apache core. |
| Analytical queries | **DuckDB** | **MIT** | Fast local analytics over receipt journals. |
| PD / fraud ML | **scikit-learn** (BSD-3) + **XGBoost** (Apache-2.0) | **BSD-3 / Apache-2.0** | Formalize `services/risk-engine/credit_score.py`. |
| Feature store | **Feast** | **Apache-2.0** | Serve underwriting features consistently. |
| Cross-chain attestations (optional) | **Ethereum Attestation Service** | **MIT** | Standard attestation format for EVM-side reputation anchors. |
| Metrics/observability | **OpenTelemetry** + **Prometheus** | **Apache-2.0** | You already expose `/metrics`; standardize. |

### 4.3 License hazards — flag / avoid

| Project | License | Verdict |
|---|---|---|
| **Neo4j Community** | **GPLv3** | ⚠ Avoid for the graph store — GPL contaminates a shipped/hosted product. Use Kùzu (MIT) or Apache AGE instead. Enterprise is commercial-only. |
| **Grafana** | **AGPLv3** | ⚠ Fine as a *deployed dashboard you don't modify or redistribute*; do not vendor/fork into the product. |
| **Memgraph** | **BSL** | ⚠ Source-available, not OSS — usage restrictions. Avoid for the core. |
| **Plausible Analytics** | **AGPLv3** | ⚠ Self-host as a separate service only; don't embed. |
| **TimescaleDB (hosted/toolkit)** | **TSL** | ⚠ Core is Apache-2.0; the "community" hyperfunctions are TSL. Stay on the Apache core for anything redistributed. |

### 4.4 Ecosystem integration (adjacent, not dependencies)

- **Railyard Mint** — mint the Cred402 **credit passport / credit-line as an
  on-chain token/NFT**. The agent passport (`AgentPassportRegistry`) and
  `CreditAuthorizationNotes` are the natural payloads; Railyard Mint becomes the
  issuance surface so a credit line is a transferable, verifiable object.
- **AITP-402** (Agent Interaction & Transaction Protocol payment layer) — Cred402
  reputation feeds AITP payment negotiation: an agent presents a Cred402 score /
  credit note during AITP-402 settlement to unlock post-paid or higher-limit
  terms. Cred402 = the reputation oracle; AITP-402 = the negotiation rail. The
  URE is designed to be the receipt these protocols emit.

---

## 5. OSS-vs-commercial verdict

**Verdict: open-core.** OSS the protocol layer as a standards play; keep the
credit-data network and capital layer commercial.

### 5.1 What goes OSS (Apache-2.0)

The `packages/*` tree in §2 — **the protocol, not the network**:
- URE spec + JSON Schemas, x402 challenge/auth/proof, EIP-712 signing.
- The **gateway middleware** (`packages/gateway`) — this is the wedge; it must be
  free and frictionless so it spreads.
- Chain adapters, trust ladder, SDKs (TS/Python/Go/Rust), MCP server.
- A **reference reputation implementation** (`policyV1/V2`, the 6 dimensions) —
  enough to be credible and auditable, not the tuned production model.
- Contract interfaces (the Odra crates should be licensed too — currently no
  license blocks even this).

Why Apache-2.0 over MIT: a protocol/standard benefits from the **explicit patent
grant**; it reassures enterprise adopters and other implementers. (MIT is
acceptable but weaker for a standard.)

**Immediate action: add a `LICENSE` file.** The repo has none today — that is a
hard blocker for the entire adoption thesis. Nobody can safely depend on
unlicensed code.

### 5.2 What stays commercial (proprietary)

The `services/*` data/credit layer — **the moat is the network, not the code**:
- **`bureau-graph`** — the aggregated cross-agent, cross-chain reputation graph
  (§3). Network-effect data; every new receipt makes it more valuable and less
  reproducible. This is the crown jewel.
- **Tuned PD model + fraud/collusion graph** (`services/risk-engine`) — the
  accuracy delta over the open reference implementation.
- **Hosted credit oracle + facilitator** with SLA, and **`pool-manager`** (LP
  capital, exposure, honest-APY accounting).
- **RealFi/compliance connectors** and enterprise dashboards/reporting.

### 5.3 Paid tiers

| Tier | Who | What | Price shape |
|---|---|---|---|
| **Free / self-host** | Any dev | OSS gateway + SDK + MCP + reference scoring, testnet | $0 |
| **Metered (x402-native)** | Agents | `GET /v1/x402/credit-score/:agentId` — **already live at 0.01 USDC** | Pay-per-call (dogfoods x402) |
| **Pro (hosted)** | x402-native teams | Hosted credit oracle, receipt anchoring, webhooks, dashboard, N calls/mo | Subscription ($ /mo) + overage |
| **Bureau / Enterprise** | Lenders, marketplaces, pools | Full graph access, tuned PD + fraud signals, compliance, pool underwriting, SLA | Data license + seats |
| **Capital / origination** | LPs & credit desks | Actual credit lines | **bps** — `economics.ts` already models origination 0.50%, interest spread 10%, facilitator 0.30% |

---

## 6. Growth angle (honest)

This is **developer/agent infrastructure plus a hackathon entry** (Algorand
Global x402 Challenge). The adoption path and money path are different timelines
— be honest about which is near and which is far.

### 6.1 Realistic adoption path

1. **Wedge — the Algorand x402 challenge (now).** The credit-score resource is a
   live, Bazaar-discoverable, standards-compatible x402 v2 endpoint. Ship it,
   get it on the challenge leaderboard, get listed in x402 discovery. This is
   distribution *and* a working demo of the whole thesis in one URL.
2. **Wedge — OSS gateway on npm (weeks).** "Drop one middleware in front of any
   paid API → it's x402-payable and it builds agent credit." Distribute via npm,
   the Coinbase x402 directory, and the Bazaar. Every install is a receipt
   source feeding the bureau — the classic open-core flywheel.
3. **Wedge — MCP server (weeks).** Agents query creditworthiness as a native
   tool. List in MCP registries; ride agent-framework adoption (Claude, etc.).
4. **Network effect (months).** More gateways → more receipts → better scores →
   scores worth paying for → more integrators. The graph compounds.
5. **Ecosystem tie-ins.** Railyard Mint (credit-line tokens) + AITP-402
   (reputation-gated settlement) put Cred402 scores where agents already
   transact.

Audiences, in order: **x402 developers → the x402 ecosystem (facilitators,
Bazaar, challenge judges) → agent marketplaces/lenders**.

### 6.2 Monetization & time-to-first-revenue

- **Today:** the 0.01 USDC credit-score endpoint can technically earn on the
  first paid call. **Honest caveat:** volume is ~zero until there are agents that
  *need* scores — cents, not a business, initially. Its real value now is proof +
  leaderboard placement.
- **6–9 months (first meaningful revenue):** hosted **Pro** subscriptions to a
  handful of x402-native teams who want managed scoring + anchoring + webhooks.
  This is the realistic first real dollars.
- **12–18 months (the big line):** **credit-origination bps** on real pooled
  capital. This is where `economics.ts` pays off — but it requires real LP
  capital, an actual default history to price risk, mainnet contract
  finalization, and a serious regulatory/compliance posture. Do **not**
  front-run this; a mispriced pool with no default data is how credit protocols
  die.
- **Ongoing:** **Bureau data licensing** to lenders/marketplaces once the graph
  is dense enough to be predictive.

**Honest risks:** the x402 agent economy is early — TAM is a bet on agents
becoming real economic actors. The biggest technical debt to adoption is
**persistence + mainnet finalization** (today most logic is in-memory sim). The
biggest business gate is **capital + regulation** for the credit-spread revenue.
The defensible asset is the **provenance-rich reputation graph**, which
compounds only if the free gateway actually spreads — so OSS distribution is not
optional, it is the growth engine.

---

## 7. Scale reality

### 7.1 Current footprint (code files / LOC, node_modules excluded)

| Module | Files | LOC | Notes |
|---|---:|---:|---|
| `lib/` (core, ledger, x402, services, casper, flare, gateway, realfi, compliance, keeperhub, graphql) | 154 | 16,752 | Largest; `lib/services` (67) + `lib/ledger` (30) dominate |
| `contracts/` (Odra Rust + EVM) | 81 | 7,673 | 14 Casper crates + Foundry |
| `test/` | 69 | 7,204 | Strong coverage |
| `frontend/` | 44 | 6,850 | 34 React components |
| `services/` (Python/Go/TS microservices) | 32 | 4,823 | risk-engine, indexer, orchestrator, notifications |
| `sdk/` (TS/Py/Go/Rust) | 15 | 4,147 | |
| `api/` | 6 | 3,675 | `server.ts` (1,117) + `state.ts` (1,542) — **split these** |
| `scripts/` | 36 | 2,836 | demos, deploy, checks |
| `cli/` | 17 | 2,258 | |
| `packages/` (chain-adapters, ts-sdk, openapi, graphql) | 22 | 2,215 | |
| `mcp/` | 4 | 1,209 | 83 tool entries |
| `agents/` | 10 | 1,022 | the autonomous economy |
| `crosschain/` | 13 | 993 | URE, trust ladder, relayers |
| `examples/` | 4 | 423 | |
| **Total (code)** | **~500** | **~62,080** | + ~22 docs, JSON manifests, infra |

### 7.2 Target footprint (rough, post-decomposition)

Enterprise hardening is roughly **+40–60% LOC**, concentrated in persistence,
tests, and the extracted bureau service — not new protocol surface.

| Area | Target files | Target LOC | Delta driver |
|---|---:|---:|---|
| `packages/protocol` + `gateway` + `trust-ladder` (extracted, OSS) | ~120 | ~14K | mostly relocation + Zod schemas |
| `packages/chain-adapters` (hardened to live) | ~60 | ~6K | real EVM/Algorand/Solana paths |
| `packages/sdk-*` + `mcp` | ~45 | ~6K | published packaging |
| `services/bureau-graph` (**new**) | ~50 | ~8K | ontology, ingest, fusion, GraphRAG query |
| `services/underwriting-api` (split from `api/`) | ~40 | ~6K | routes split + persistence |
| `services/pool-manager` + `facilitator` + `compliance` (**new/extracted**) | ~50 | ~7K | capital/exposure/SLA |
| `services/risk-engine` (formalized ML) | ~25 | ~5K | PD model + feature store |
| `contracts/` (mainnet-ready + audits) | ~90 | ~10K | finalization, upgrade paths |
| `apps/console` + `apps/docs` | ~70 | ~10K | multi-tenant, auth |
| `tests/` | ~140 | ~16K | 80%+ coverage across packages |
| **Total** | **~750** | **~95–100K** | |

### 7.3 Done-ladder (sequenced, each rung shippable)

1. **License + seam (days).** Add `LICENSE` (Apache-2.0 for `packages/*`);
   mark the `services/*` boundary. *Unblocks everything.*
2. **Split the god-files (days).** `api/server.ts` + `api/state.ts` → domain
   routes; adopt Fastify/Hono + Zod at the boundary.
3. **Persist the ledger (weeks).** Extract `lib/ledger` → `services/bureau-graph`
   over Postgres + Kùzu/AGE; the Go indexer writes graph edges with
   time+provenance. *This is the single biggest maturity jump.*
4. **Make the task graph explicit (weeks).** Formalize `CreditAgent.underwrite`
   as the diamond: parallel factor workers, separate verify node, single merge
   owner, human gate on money edges.
5. **Mainnet finalization path (weeks–months).** Wire receipt/score writes
   through `lib/casper` + adapters so anchors are real, not simulated.
6. **Publish OSS packages (weeks).** npm + PyPI + crates.io; list gateway in the
   x402 directory and MCP registries. *Growth engine on.*
7. **Bureau + PD productization (months).** Formalize `risk-engine` (scikit-learn
   + XGBoost + Feast); expose the tuned model + fraud signals as the paid tier.
8. **Capital layer (months, gated).** `pool-manager` with real LPs, honest-APY
   accounting, and a compliance/regulatory posture — only after a default
   history exists to price risk.

---

### Appendix — grounding index

- x402 protocol: `lib/x402/x402.ts`, `eip712.ts`, `gateway.ts`,
  `algorand_gateway.ts`, `facilitator.ts`
- URE / provenance: `crosschain/standards/receipts.ts`,
  `crosschain/schemas/*.json`, `crosschain/trust-ladder/*`
- Credit/reputation engine: `lib/core/risk_policy.ts`, `lib/core/economics.ts`,
  `lib/ledger/contracts/reputation_engine.ts`, `lib/services/reputation_breakdown.ts`,
  `agents/credit_agent.ts`
- Fraud graph: `lib/services/fraud_service.ts`, `services/risk-engine/fraud_graph.py`
- Chain adapters: `packages/chain-adapters/src/adapters/*`
- Contracts: `contracts/*/src/lib.rs` (14 Odra crates), `deploys.testnet.json`
- API/console: `api/server.ts`, `api/v1/router.ts`, `frontend/src/components/*`
```
