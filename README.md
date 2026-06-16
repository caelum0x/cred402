# Cred402 — credit lines for autonomous RWA agents on Casper

> **Cred402 is an agent credit protocol for Casper. Autonomous AI agents perform paid RWA services through x402, record signed machine-to-machine receipts on Casper, build verifiable reputation, and access DeFi credit lines based on their cash flow and accuracy. It turns agents from tools into financeable economic actors.**

**The sticky phrase: _credit scores for AI agents._**

Agents need identity → payment rails → reputation → working capital. Casper provides the trust layer; Cred402 turns that trust into a financial protocol.

---

## The magic loop

```
1. RWA protocol needs evidence.
2. Agent buys paid data via x402.
3. Agent produces an RWA verification report.
4. Report hash + payment receipt are recorded on Casper.
5. Agent earns revenue.
6. Agent reputation improves if the report proves accurate.
7. Cred402 increases the agent's credit line.
8. DeFi lenders finance the agent's future work.
9. More agents join because they can earn, borrow, and build reputation.
```

This repo implements that loop end to end: five smart contracts, a five-agent runtime, a real HTTP x402 flow, and a live dashboard.

---

## Quickstart

```bash
# 1. install backend deps (zero runtime deps — node:http + node:crypto only)
npm install

# 2. run the whole loop in your terminal (no server needed)
npm run demo            # honest happy path
npm run demo:dispute    # stretch: falsified evidence -> watchdog slashing

# 3. run the live system + dashboard
npm run start                       # API + x402 server on :4021      (terminal 1)
cd frontend && npm install && npm run dev   # dashboard on :5173       (terminal 2)
# then click "Run full loop" in the dashboard, or:
npm run seed                        # drive the server through the loop

# 4. prove the real HTTP x402 flow against the running server
npx tsx scripts/x402_client.ts energy_output

# 5. operate the protocol as an AI agent over MCP (p2)
npm run mcp:demo        # drives the MCP server like a real client
npm run mcp             # start the stdio MCP server for Claude Desktop etc.

# 6. use the TypeScript SDK (server must be running)
npm run sdk:demo

# 7. omnichain flow (p3): Casper-rooted, chain-executed
npm run demo:multichain   # bind EVM addr → earn on Base → anchor to Casper →
                          # CAN-gated borrow on Base vault → repay, then the SAME
                          # flow on Cosmos (Osmosis) AND Solana satellites —
                          # three chain families under one shared Casper-rooted cap

# 8. tests + typecheck
npm test                # 28 cases (p1 + p2 + p3)
npm run typecheck
```

For a single-origin production-style run, build the dashboard and let the API serve it:

```bash
cd frontend && npm install && npm run build && cd ..
npm run start            # dashboard now at http://localhost:4021/
```

---

## Credit-bureau analytics

Beyond the core lending loop, Cred402 exposes a full credit-bureau analytics layer
(`lib/services/`) — each surface is available over REST `/v1`, GraphQL, MCP, the
`cred402` CLI, and all four SDKs:

| Surface | Endpoint | What it answers |
| ------- | -------- | --------------- |
| Discovery | `GET /v1/discovery` | rank agents by a composite of reputation + credit + web-of-trust + tier − fraud |
| Web of trust | `GET /v1/attestations/graph` · `POST /v1/attestations` | who vouches for whom (anti-Sybil-capped reputation boosts) |
| Peer benchmark | `GET /v1/agents/:id/benchmark` | percentile + rank within the agent's service-type cohort |
| Credit file | `GET /v1/agents/:id/history` | every on-chain event concerning an agent, categorized |
| Score trend | `GET /v1/agents/:id/score-trend` | credit-score / reputation trajectory over time |
| Readiness | `GET /v1/agents/:id/readiness` | pass/fail checklist of the gates to qualify for credit |
| What-if | `POST /v1/credit/simulate` | preview a credit decision for hypothetical signals (read-only) |
| Pre-approval offers | `POST /v1/credit/offers` → `…/accept` | time-bounded offer the agent accepts to open a line |
| Portfolio | `GET /v1/credit/portfolio` | LP concentration risk (Herfindahl HHI) and exposure breakdowns |
| Yield projection | `GET /v1/credit/yield-projection` | forward LP yield over 30/90/365 days |
| Risk alerts | `GET /v1/risk/alerts` | always-on severity-ranked monitoring sweep |
| Compliance | `GET /v1/compliance/report` | per-jurisdiction KYB coverage + sanctions exposure |

Try them from the CLI: `npx tsx cli/cred402.ts bureau discover`,
`… bureau portfolio`, `… bureau readiness <agent>`, `… bureau trend <agent>`.
Each agent's full shareable credit file is at `GET /report/:id` (server-rendered).

---

## Architecture

```
cred402/
  contracts/                 # 11 Odra (Rust) smart contracts for Casper
    agent_registry/          #   identity, stake, reputation, credit score
    agent_passport/          #   read-optimized public profile    (p2)
    x402_receipt_registry/   #   signed x402 receipts + replay protection
    rwa_asset_registry/      #   canonical RWA asset registry      (p2)
    rwa_evidence_registry/   #   hashed RWA evidence linked to receipts
    reputation_engine/       #   multi-dimensional reputation      (p2)
    agent_credit_pool/       #   the DeFi pool: deposit / open / draw / repay
    risk_policy_manager/     #   upgradable underwriting policy (v1 -> v2)
    dispute_court/           #   challenges + verdicts             (p2)
    slashing_vault/          #   slashed stake distribution        (p2)
    governance/              #   params, fees, emergency pause     (p2)

  lib/
    core/                    # types, blake2b hashing, CSPR motes, risk policy math
    ledger/                  # faithful in-memory simulation of all contracts + event bus
    services/                # FraudService: receipt-graph collusion detection (p2)
    x402/                    # ed25519 identities, 402 challenge, signed payment proofs

  agents/                    # the autonomous economic actors
    buyer_agent.ts           #   RWARequestAgent: posts jobs, pays via x402
    evidence_seller_agent.ts #   runs paid endpoints, attests evidence, earns
    credit_agent.ts          #   underwrites agents + scores RWA jobs
    treasury_agent.ts        #   manages pool liquidity + funds draws
    watchdog_agent.ts        #   reacts to streaming events: dispute, slash, freeze
    dispute_judge_agent.ts   #   investigates disputes, recommends verdicts   (p2)
    liquidity_router_agent.ts#   monitors pool utilization                    (p2)
    economy.ts               #   wires the fleet + runs the magic loop

  api/                       # zero-dependency node:http server (REST + SSE + x402)
  mcp/                       # Cred402 MCP server: 16 tools + 6 resources      (p2)
  sdk/                       # @cred402/sdk TypeScript client                  (p2)
  scripts/                   # run_demo_flow, steps, seed, deploy_testnet, x402/mcp/sdk demos
  frontend/                  # Vite + React dashboard (6 tabs + live event feed)
  db/migrations/             # Postgres indexer schema (p2 §10.1)
  docs/                      # architecture, demo_script, risk_model, x402_flow, protocol/*, whitepaper/*
  test/                      # node:test suite (18 cases)
  .github/workflows/ci.yml   # backend + frontend + demo + contracts CI
```

This repo builds the full **p1** vertical slice, the **p2 production-blueprint
protocol layer** (Agent Passport, Reputation Engine, RWA Asset Registry, Dispute
Court, Slashing Vault, Governance, MCP server, SDK, fraud detection, x402 replay
protection), and the **p3 omnichain layer** (below). RWA evidence is derived from
**real Open-Meteo solar data** via a PV physics model; all signatures use **real
production crypto** (`@noble/curves` secp256k1 + `@noble/hashes` keccak256/blake2b).

### p3 — Casper-rooted, chain-executed (omnichain)

Casper is the canonical root of trust; other chains are execution/liquidity
satellites that anchor back to it.

```
crosschain/standards/   # CAID, ABE, URE, UAID, EAE, CAN — real dual-signature
                        #   (ed25519 casper + secp256k1 evm) + JSON schemas + validator
crosschain/schemas/     # JSON Schema for every envelope
contracts/{evm,solana,cosmos,move,bitcoin}/   # satellite contracts
packages/chain-adapters/# ChainAdapter SDK: CasperAdapter (root) + Evm/Cosmos/Solana/Move satellites + vaults
chains/                 # per-chain network + deployment + credit-cap configs
crosschain/relayers/    # EVM/Solana/Cosmos → Casper relayers
services/               # multichain indexer, global-exposure, credit-note, reconciliation
```

Casper-side contracts (in `lib/ledger`, mirrored as Odra): `AddressBindingRegistry`,
`ExternalReceiptRegistry`, `GlobalExposureManager` (the multichain over-borrow
guard), `CreditAuthorizationNotes`, `UpgradeManager`. An agent earns x402 revenue
on any chain, the receipt anchors to Casper, reputation settles on Casper, and a
satellite vault may lend **only** against a Casper-signed Credit Authorization Note
within the agent's global exposure cap. See [`ROADMAP.md`](ROADMAP.md).

### Why a simulated ledger?

A live Testnet deploy needs a funded secret key and the compiled WASM. To keep the
full agent economy **reproducible on any machine**, `lib/ledger` is a faithful
in-memory mirror of the Odra contracts: same state, same methods, same events.
Swapping it for live `casper-js-sdk` calls is a drop-in — the agents, x402 flow,
and dashboard are unchanged. See `scripts/deploy_testnet.ts` for the live deploy
plan and `contracts/` for the real Rust contracts.

---

## Casper-native building blocks used

| Building block            | Where in Cred402 |
| ------------------------- | ---------------- |
| Account abstraction       | every agent owns an ed25519 identity (`lib/x402/keys.ts`, `agents/base_agent.ts`) |
| x402 micropayments        | `lib/x402`, `api/paid_evidence_server`, real 402 → proof → report |
| casper-eip-712            | domain-separated `PaymentAuthorization` signed by the payer agent |
| Streaming events          | `lib/ledger/events.ts` → SSE → dashboard feed + WatchdogAgent |
| Odra smart contracts      | `contracts/*` (5 modules) |
| Upgradable contracts      | `RiskPolicyManager` swaps policy v1 → v2 without redeploying the pool |
| Predictable fees          | agents budget x402 spend before they are paid (the reason credit exists) |

---

## The demo in 90 seconds

A tokenized solar farm (SPV #A17, Izmir) wants a DeFi credit line. Before lenders
fund it, autonomous agents must verify production, weather risk and receivable
quality. Cred402 pays those agents through x402, records their work on Casper,
scores their reliability, and gives high-performing agents working-capital credit.

Run `npm run demo` to watch all six scenes; see [`docs/demo_script.md`](docs/demo_script.md).

## Accountability (stretch)

`npm run demo:dispute` shows the system is not merely optimistic: a seller submits
falsified energy output, the WatchdogAgent cross-checks it against an independent
source, opens a dispute, slashes the stake, freezes the credit line and downgrades
reputation — all driven by Casper streaming events.

---

## License

MIT. Built for the Casper Innovation Track (Agentic AI × DeFi × RWA).
# cred402
