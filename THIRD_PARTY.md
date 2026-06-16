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
| `casper-ecosystem/casper-js-sdk` | byte-exact Casper 2.0 deploy build/sign/submit + WASM install (p8 real Testnet write path) | Apache-2.0 | `lib/casper/sdk_signer.ts`, `lib/casper/install.ts`, `scripts/deploy_testnet.ts` | Dependency (lazy-loaded on the live path only) |
| `modelcontextprotocol/typescript-sdk` (`@modelcontextprotocol/sdk`) | official MCP server transport for the 32-tool registry (p9) | MIT | `mcp/server_sdk.ts`, tested via the SDK client in `test/mcp_sdk.test.ts` | Dependency |
| `make-software/casper-x402` | canonical Casper x402 facilitator (x402 V2) — verify/settle client (p9) | Apache-2.0 | `lib/x402/facilitator.ts` (client to the facilitator service) | Wire-contract client; facilitator runs as a sidecar |
| `casper-ecosystem/casper-eip-712` (`@casper-ecosystem/casper-eip-712`) | real EIP-712 typed-data digest for x402 payment authorizations | Apache-2.0 | `lib/x402/eip712.ts` (signed digest used by `lib/x402/x402.ts`) | Dependency |
| `casper-network/casper-sidecar` | live node event feed (SSE `/events`) consumed for WatchdogAgent/indexer | Apache-2.0 | `lib/casper/sidecar.ts`, `scripts/sidecar_watch.ts` | Faithful SSE client to the Sidecar service |
| `stripe/stripe-node` (`stripe`) | real test-mode webhook HMAC verification + event mapping → on-chain fiat receipts (p10) | MIT | `lib/realfi/stripe.ts` | Dependency |
| `plaid/plaid-node` (`plaid`) | real sandbox bank verification → Bank Verification Envelope (p10) | MIT | `lib/realfi/plaid.ts` | Dependency |
| `foundry-rs/foundry` + `forge-std` | real EVM satellite compile + Base Sepolia deploy (p10) | Apache-2.0/MIT | `contracts/evm/` (`forge build`, `script/Deploy.s.sol`) | Build/deploy tool; `forge-std` vendored + gitignored |
| Casper Wallet (`make-software`) | real browser-extension connect + message/deploy signing in the console | Apache-2.0 | `frontend/src/lib/casperWallet.ts`, `hooks/useCasperWallet.ts`, `components/WalletButton.tsx` | Typed wrapper over the extension's injected `window.CasperWalletProvider` (no npm dep) |
| `privatenumber/tsx` | TypeScript execute/runtime for CLI + demos | MIT | dev tooling, `scripts/*` | Dev dependency |
| `microsoft/TypeScript` | Type system + `tsc` typecheck | Apache-2.0 | whole repo | Dev dependency |
| `vitejs/vite` + `facebook/react` | Console dashboard build + UI | MIT | `frontend/` | UI dependency |
| Open-Meteo API | Live solar/weather data for real RWA evidence | CC BY 4.0 (data), free API | `api/rwa_data/solar_provider.ts` | Real data source — no mock |
| Node.js `node:test`, `node:crypto` | Test runner + ed25519 agent identities | MIT-like (Node) | `test/*`, `lib/x402/keys.ts` | Standard library |

## Designed-for integration (not yet wired in this repo)

These are part of the production blueprint (see `PRODUCTION.md` and the real-integration phase docs `docs/p8.md`–`docs/p10.md`).
The Cred402 protocol they wrap is implemented here; the integrations below are the
deployment/forking surface and are tracked in `ROADMAP.md`.

| Project | Use | License | Planned location | Notes |
|---|---|---|---|---|
| `make-software/cspr-design` | Casper-native UI component kit | see repo | `frontend/` | Optional reskin of the existing console |
| `openai/openai-agents-python`, `langchain-ai/langgraph` | Python agent runtime + durable workflows | MIT | `services/agent-orchestrator` | TS agents implemented here |

When a project is forked rather than depended on, its `LICENSE` is preserved under
`third_party/<project>/LICENSE` and any forked service keeps a `NOTICE` file.

## Originality boundary (p7 §10)

Cred402 owns: the Agent Passport, CAID, Universal Receipt Envelope, RWA Evidence
Graph, Proof-of-Service Revenue model, Reputation Engine, Agent Credit Score,
Agent Credit Pool, dispute/slashing logic, Watchdog behavior, fraud graph,
cross-chain trust ladder, RealFi Bridge (FRE/OVE/BVE), the solar RWA demo flow,
and the Casper-root omnichain architecture. The open-source projects above are
infrastructure rails; the protocol is new.
