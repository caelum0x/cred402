# Third-Party Open Source Used by Cred402

Cred402 uses third-party open-source software as dependencies, development tools,
and (by design) forked services and integration templates. The Cred402 protocol
contracts, agent-credit logic, x402/RealFi receipt models, RWA evidence model,
reputation model, fraud graph, cross-chain trust ladder, and product UX are newly
developed for this project — the open-source projects below are rails, not the
product.

## Actually used in this repository

| Project | Use | License | Location | Modifications |
|---|---|---|---|---|
| `paulmillr/noble-curves` (`@noble/curves`) | secp256k1 keys/signatures for EVM address bindings + relayer proofs | MIT | `lib/x402/evm.ts`, `crosschain/` | Dependency |
| `paulmillr/noble-hashes` (`@noble/hashes`) | blake2b-256 (Casper content hashing) + keccak256 | MIT | `lib/core/hash.ts`, `lib/x402/` | Dependency |
| `odradev/odra` | Casper smart-contract framework (Wasm) | MIT | `contracts/*` (14 Odra crates) | Framework dependency |
| `privatenumber/tsx` | TypeScript execute/runtime for CLI + demos | MIT | dev tooling, `scripts/*` | Dev dependency |
| `microsoft/TypeScript` | Type system + `tsc` typecheck | Apache-2.0 | whole repo | Dev dependency |
| `vitejs/vite` + `facebook/react` | Console dashboard build + UI | MIT | `frontend/` | UI dependency |
| Open-Meteo API | Live solar/weather data for real RWA evidence | CC BY 4.0 (data), free API | `api/rwa_data/solar_provider.ts` | Real data source — no mock |
| Node.js `node:test`, `node:crypto` | Test runner + ed25519 agent identities | MIT-like (Node) | `test/*`, `lib/x402/keys.ts` | Standard library |

## Designed-for integration (not yet wired in this repo)

These are part of the production blueprint (`docs/p2.md`, `docs/p6.md`, `docs/p7.md`).
The Cred402 protocol they wrap is implemented here; the integrations below are the
deployment/forking surface and are tracked in `ROADMAP.md`.

| Project | Use | License | Planned location | Notes |
|---|---|---|---|---|
| `make-software/casper-x402` | x402 facilitator + paid-server base | Apache-2.0 | `services/facilitator-go`, `services/x402-gateway` | Cred402 receipt/evidence hooks |
| `casper-ecosystem/casper-js-sdk` | Casper Testnet interaction (replaces in-memory ledger transport) | Apache-2.0 | `packages/ts-sdk`, `apps/console` | Drop-in behind the ledger interface |
| `casper-ecosystem/casper-eip-712` | Typed agent authorizations | see repo | `packages/typed-authorizations` | Cred402 typed messages |
| `make-software/casper-wallet-sdk`, `cspr-design` | Wallet + UI components | see repo | `apps/console` | UI/wallet |
| `casper-network/casper-sidecar` | Event stream/indexing input | see repo | `services/event-indexer` | Replaces SSE stand-in |
| `modelcontextprotocol/typescript-sdk` | MCP server SDK | MIT | `mcp/` | Current MCP server is a zero-dep JSON-RPC impl |
| `openai/openai-agents-python`, `langchain-ai/langgraph` | Python agent runtime + durable workflows | MIT | `services/agent-orchestrator` | TS agents implemented here |
| `stripe-samples/accept-a-payment` | Stripe adapter starter | MIT | `lib/services/realfi_bridge.ts` examples | RealFi Bridge owns the on-chain commitment path |
| `plaid/quickstart` | Plaid bank-data starter | MIT | RealFi Bridge examples | Bank Verification Envelope flow |
| OpenZeppelin Contracts, Foundry | EVM satellite contracts + tooling | MIT | `contracts/evm` | Satellite mirrors |

When a project is forked rather than depended on, its `LICENSE` is preserved under
`third_party/<project>/LICENSE` and any forked service keeps a `NOTICE` file.

## Originality boundary (p7 §10)

Cred402 owns: the Agent Passport, CAID, Universal Receipt Envelope, RWA Evidence
Graph, Proof-of-Service Revenue model, Reputation Engine, Agent Credit Score,
Agent Credit Pool, dispute/slashing logic, Watchdog behavior, fraud graph,
cross-chain trust ladder, RealFi Bridge (FRE/OVE/BVE), the solar RWA demo flow,
and the Casper-root omnichain architecture. The open-source projects above are
infrastructure rails; the protocol is new.
