# Cred402 — hackathon submission packet (KeeperHub × Flare)

> **Cred402 is a Casper-rooted credit protocol for autonomous AI agents.** Agents earn
> verifiable x402 revenue on any chain; Casper roots their identity, reputation, receipts,
> and credit policy. These two integrations are the *last mile* of that credit line: the
> **KeeperHub** integration lets an agent's credit decision land on-chain reliably
> (simulate → smart gas → private routing → audit), and the **Flare** integration gives it
> interoperable and confidential primitives — FXRP (FAssets) working capital, FTSO pricing,
> FDC cross-chain attestation, and TEE-attested confidential credit scoring. One agent, one
> arc: earn → score → borrow → manage → automate → collateralize → mint → sell → schedule.

| | |
|---|---|
| **Demo video** | [`media/cred402-hackathon-demo.mp4`](../media/cred402-hackathon-demo.mp4) |
| **Poster** | [`media/cred402-hackathon-poster.png`](../media/cred402-hackathon-poster.png) |
| **Live console** | https://cred402.vercel.app |
| **Live API** | https://cred402-1.onrender.com/v1/health |
| **GitHub repo** | https://github.com/caelum0x/cred402 |
| **One-run story** | `npm run demo:grand` (the whole arc in one terminal) |
| **Readiness check** | `npm run submit:check` (mirrors this packet — what's done, what needs your keys) |

Run `npm run submit:check` at any time: it runs the KeeperHub × Flare pipeline end-to-end
in sim and prints, per hackathon, the requirements, what is already satisfied, and the exact
commands to produce the two remaining artifacts (a real transaction, a Coston2 deploy).

---

## 1. KeeperHub — "The Last Mile"

**Submission deadline: 2026-08-13.** Every project must use KeeperHub as its on-chain
execution layer.

### Submission checklist

| Requirement | Value |
|---|---|
| **GitHub source** | https://github.com/caelum0x/cred402 |
| **Demo video** (agent executing on-chain through KeeperHub) | [`media/cred402-hackathon-demo.mp4`](../media/cred402-hackathon-demo.mp4) |
| **Transaction link** (a tx the agent executed via KeeperHub) | **TODO** — produce with a real key; see [Produce the required transaction link](#produce-the-required-transaction-link). The audit record's `tx_hash` is the link. |

### What it is

Cred402 spends most of its code *deciding* creditworthiness — verifiable x402 revenue,
reputation, risk policy, a Casper-signed Credit Authorization Note (CAN), and a shared
global-exposure cap. **KeeperHub is the only thing allowed to move value on-chain**, and
only for a CAN that already authorized it. When an agent decides to draw / repay / deleverage
FXRP credit, KeeperHub executes it through the full reliability envelope:

```
pay-per-execution (x402 / MPP)  →  preflight simulate (revert short-circuits, nothing broadcast)
  →  smart gas w/ exponential backoff  →  MEV-protected private routing
  →  poll to a tx hash (cold-start retry, same idempotency key)  →  append-only audit trail
```

KeeperHub is injected as an `OnchainExecutor` into the Flare/EVM chain adapter, which decides
and FTSO-prices the draw and hands the actual submission to KeeperHub. It never has custody or
discretion. Full write-up: [`keeperhub_integration.md`](keeperhub_integration.md).

### KeeperHub surfaces used → where in the code

| KeeperHub surface | Cred402 file | What it does |
|---|---|---|
| **MCP server** (`execute_contract_call`, `execute_transfer`, `get_direct_execution_status`) | `lib/keeperhub/client.ts` | Streamable-HTTP MCP client to `https://app.keeperhub.com/mcp`, `Authorization: Bearer kh_<key>`; live only when `KEEPERHUB_API_KEY` is set. |
| **x402 / MPP pay-per-execution + gas sponsorship** | `lib/keeperhub/payments.ts` | `PaymentRouter` picks x402 (Base USDC), MPP (Tempo USDC.e facilitator), or `sponsored` (mainnet ETH gas sponsorship). |
| **Smart gas estimation** | `lib/keeperhub/gas.ts` | `SmartGasEstimator`: EIP-1559 pricing with `eip1559-exponential-backoff` fee bumps + retry schedule. |
| **Preflight simulation + private routing + poll** | `lib/keeperhub/executor.ts` | `KeeperHubExecutor`: `simulate:true` preflight, private submit, cold-start-aware polling with reused idempotency key. |
| **Audit trail / observability** | `lib/keeperhub/audit.ts` | `AuditTrail`: append-only records + a reliability `summary()`. |
| **Workflow builder + cron** | `lib/flare/automations.ts`, `lib/keeperhub/scheduler.ts` | Credit Automations register as KeeperHub workflows (`create_workflow` + `validate_cron`); the Autonomous Scheduler mirrors the scheduled-workflow/cron surface. |

### Judging-criteria mapping

| Criterion | Where it is satisfied |
|---|---|
| **Executes on-chain via KeeperHub** (working tx, not mockups) | `KeeperHubExecutor.submitLive()` drives `execute_contract_call` + `get_direct_execution_status` over the MCP server; `FlareAdapter.drawCredit()` / `repayCredit()` inject it as the `OnchainExecutor`. `lib/keeperhub/executor.ts`, `packages/chain-adapters/src/adapters/flare/FlareAdapter.ts` · [`keeperhub_integration.md`](keeperhub_integration.md) |
| **Use of KeeperHub surfaces** (MCP, x402, MPP, workflow builder, audit trail) | MCP (`client.ts`), x402/MPP + sponsorship (`payments.ts`), smart gas (`gas.ts`), simulation + private routing (`executor.ts`), audit (`audit.ts`), workflow + cron (`automations.ts`, `scheduler.ts`). |
| **Reliability + observability** (retries, gas handling, audit trail) | Preflight `simulate:true`, exponential-backoff gas, `upstream_cold_start` retry with reused idempotency key, append-only `AuditTrail` + `summary()`, surfaced at `GET /v1/keeperhub/reliability` · `GET /v1/keeperhub/audit` and MCP `cred402.keeperhub_reliability` / `cred402.keeperhub_audit`. |
| **Originality + real-world usefulness** | KeeperHub is used as a credit-protocol *execution seam*: agents make the credit decision, KeeperHub is the only thing allowed to move value — and only for a CAN that already authorized it. The Autonomous Credit Keeper turns FTSO price risk into an on-chain `check → execute` protective deleverage. [`credit_keeper.md`](credit_keeper.md) |
| **Integration quality + DX** | One `OnchainExecutor` interface serves every EVM satellite; identical `ExecutionResult` shape across sim and real; env-driven; **no key required to demo** (`npm run keeperhub:execute`). [`keeperhub_integration.md`](keeperhub_integration.md) |

### Produce the required transaction link

The pipeline runs green in sim with no keys; the submission's transaction link needs a real
KeeperHub key. Exactly as `npm run submit:check` prints:

```bash
# 1. Create an org API key at https://app.keeperhub.com  (Settings → API Keys)
# 2. Configure it (optional: sponsor gas on mainnet Ethereum):
export KEEPERHUB_API_KEY=kh_your_org_key
export KEEPERHUB_GAS_SPONSORSHIP=1        # optional, mainnet ETH only

# 3. Execute a real contract call through KeeperHub's MCP server:
npm run keeperhub:execute -- \
  --chain 114 --to <vault> --fn "executeDraw(bytes32,address,uint256)"
```

`executor.isLive()` reports which path ran; **the audit record's `tx_hash` is your submission
transaction link** (also queryable at `GET /v1/keeperhub/audit`). Without the key the same
command runs the deterministic sim — full pipeline, identical `ExecutionResult` shape, no
network.

### Onboarding-UX bounty (Best Onboarding UX Improvement)

Cred402's design lowers the zero-to-first-execution barrier for a KeeperHub agent:

- **Sim-first.** The entire KeeperHub envelope (simulate → gas → private routing → audit)
  runs deterministically with **no keys**, so `npm test` is green on any machine and a
  newcomer sees a full execution + audit trail before creating an account.
- **One-command demos.** `npm run keeperhub:execute`, `npm run keeper:run`,
  `npm run automations:run`, `npm run scheduler:run`, and `npm run demo:grand` each run a
  complete on-chain-shaped flow in a single command.
- **A guided path to production.** `npm run submit:check` and this doc spell out the exact
  three commands (create key → export → execute) to go from sim to a real tx hash — turning
  "integrate KeeperHub" into a copy-paste.

---

## 2. Flare Summer Signal

**Final submission: 2026-08-14.**

| Field | Value |
|---|---|
| **Project name** | Cred402 — credit lines for autonomous RWA agents |
| **Selected bounties** | **Bounty 1 — Interoperable Asset Products ($6k)** *and* **Bounty 2 — Confidential Compute Apps ($6k)** |
| **Product description** | A Casper-rooted credit protocol whose Flare satellite lends the FAsset **FXRP** against a Casper-signed CAN, priced by the **live FTSO** XRP/USD feed, with the **FDC** attesting the cross-chain payment that makes the agent creditworthy — and scores probability-of-default inside **Flare Confidential Compute** so the borrower's raw cash flow never leaves the enclave. |
| **Target user** | Autonomous AI agents that earn x402 revenue; operators managing agent fleets; RWA protocols that need to finance verification work. |
| **Demo** | Live console https://cred402.vercel.app · video [`media/cred402-hackathon-demo.mp4`](../media/cred402-hackathon-demo.mp4) · one-run `npm run flare:credit` / `npm run demo:grand` |
| **GitHub** | https://github.com/caelum0x/cred402 |

### How it uses Flare → code + doc

| Flare primitive | Use in Cred402 | Code | Doc |
|---|---|---|---|
| **FTSO** | Position health + collateral pricing: FXRP debt marked to live XRP/USD; multi-feed pricing of the collateral basket (USDC/BTC/ETH/XRP/FLR) | `lib/flare/ftso.ts`, `lib/flare/positions.ts`, `lib/flare/collateral.ts` | [`flare_integration.md`](flare_integration.md), [`collateral.md`](collateral.md), [`credit_keeper.md`](credit_keeper.md) |
| **FDC** | Cross-chain payment attestation: proves the off-Flare x402 payment settled, and attests the XRPL payment that backs an FXRP mint (fail-closed: unverified → no mint) | `lib/flare/fdc.ts`, `lib/flare/fassets_mint.ts` | [`flare_integration.md`](flare_integration.md), [`fassets.md`](fassets.md) |
| **FAssets (FXRP)** | Mint FXRP 1:1 from attested XRP → post as FTSO-priced XRP collateral (60% LTV); the credit line is drawn and repaid in FXRP | `lib/flare/fassets_mint.ts`, `packages/chain-adapters/src/adapters/flare/fassets.ts` | [`fassets.md`](fassets.md), [`flare_integration.md`](flare_integration.md) |
| **Confidential Compute (TEE)** | Private probability-of-default scoring: raw features enter an Intel-TDX enclave; only an attested score + input/model commitments leave | `lib/flare/confidential_score.ts` | [`flare_integration.md`](flare_integration.md) (Bounty 2) |

### What was newly built / ported / integrated / improved

- **Newly built:** `FlareAdapter.ts` (Flare satellite chain adapter), `FlareSatelliteVault.ts`
  (CAN-gated FXRP credit vault), `lib/flare/ftso.ts` / `fdc.ts` / `fassets.ts` (FTSO price
  client, FDC attestation client, FXRP model), `lib/flare/confidential_score.ts` (Confidential
  Compute PD scorer + verifier), `lib/flare/positions.ts` (FTSO health-factor engine),
  `lib/flare/keeper.ts` (Autonomous Credit Keeper), `lib/flare/automations.ts` (Credit
  Automations), `lib/flare/collateral.ts` (FTSO-priced multi-asset collateral),
  `lib/flare/fassets_mint.ts` (FAssets mint → collateralize), `lib/keeperhub/scheduler.ts`
  (Autonomous Scheduler), `lib/flare/satellite.ts` (the wiring seam), and
  **`contracts/flare/`** (`Cred402FlareCreditVault.sol` + interfaces + `DeployCoston2.s.sol`).
- **Integrated (Flare's enshrined capabilities):** FTSO (`FtsoV2.getFeedById` via the
  FlareContractRegistry), FDC (`Payment` attestation), FAssets (FXRP as ERC-20 collateral),
  and Flare Confidential Compute (TEE remote attestation).
- **Ported / extended:** the existing Casper cross-chain **CAN + global-exposure** model
  (`crosschain/standards/*`, the Casper root, `RiskEngineV2`) was extended to Flare as a new
  satellite — same USD denominator, same single-use signed notes, same exposure reconciliation.
- **Improved:** the whole Cred402 credit stack now spans Flare — an agent's credit line is
  drawn in real interoperable liquidity (FXRP), continuously marked to a decentralized oracle
  (FTSO), backed by attested cross-chain facts (FDC), and scored privately (Confidential
  Compute), instead of living only on Casper.

### Deployment — Coston2

Target network: **Flare Testnet Coston2, chain id 114 (`eip155:114`)**. FtsoV2 is resolved
from the FlareContractRegistry (`0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019`) at runtime — no
oracle address is hardcoded. Deploy exactly as `npm run submit:check` prints:

```bash
# 1. Fund a Coston2 key (C2FLR gas + FXRP): https://faucet.flare.network/coston2
# 2. Configure the deployer:
export PRIVATE_KEY=0x...                 # deployer, funded with C2FLR
export FXRP_ADDRESS=0x...                # FXRP FAsset ERC20 (6 dp)
export CASPER_POLICY_KEY_HASH=0x...      # 32-byte Casper policy ed25519 public key

# 3. Deploy the vault:
cd contracts/flare
forge script script/DeployCoston2.s.sol:DeployCoston2 --rpc-url coston2 --broadcast

# 4. Point the app at live FTSO reads and run:
export FLARE_RPC_URL=https://coston2-api.flare.network/ext/C/rpc
npm run flare:credit    # or: npm run fassets:mint
```

**Smart contract addresses** (record after deploy):

| Contract | Network | Address |
|---|---|---|
| `Cred402FlareCreditVault` | Coston2 (114) | **TODO** |
| FXRP FAsset (ERC-20, 6 dp) | Coston2 (114) | **TODO** (`FXRP_ADDRESS`) |
| FtsoV2 | Coston2 (114) | resolved from FlareContractRegistry `0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019` at runtime |

Verify on Blockscout: `https://coston2-explorer.flare.network` (`--verifier blockscout
--verifier-url https://coston2-explorer.flare.network/api`).

### Short roadmap / next steps

- **Mainnet FXRP** — deploy the vault to Flare Mainnet (chain 14) with production FXRP
  liquidity.
- **Real FDC verifier** — wire `FLARE_FDC_VERIFIER_URL` to a production XRP verifier and run
  the full attest-then-mint / attest-the-payment path on-chain.
- **Live FTSO** — run `FLARE_RPC_URL` continuously so every position is marked to the live
  oracle in production, not the deterministic reference.
- **More collateral assets** — extend the FTSO-priced basket beyond USDC/BTC/ETH/XRP/FLR as
  more feeds are useful.
- **KeeperHub gas sponsorship on mainnet ETH** — enable `KEEPERHUB_GAS_SPONSORSHIP` so agents
  pay nothing for the on-chain execution of their credit actions.

---

## 3. QIE Hackathon 3.0

**Submission deadline: 2026-11-30** (demo week Dec 1-5, winners announced Dec 10, 2026).
Sourced directly from `hackathon.qie.digital` (home + dashboard pages), corroborated by
Decrypt/BeInCrypto/CryptoDaily/CryptoSlate press coverage of "QIE Blockchain Hackathon 3.0".
**Caveat:** the dashboard's `/dashboard/categories` sub-page returned a JS-shell with no
extractable text on fetch, so the 5-track category list below is corroborated from the home
page and press coverage, not scraped directly off that sub-page — treat the deadline and track
list as well-corroborated but not independently primary-sourced beyond the home page.

Cred402 is targeting the **AI & Autonomous Agents** track (one of 5: DeFi & Financial
Infrastructure, AI & Autonomous Agents, Consumer Applications & Social, Commerce &
Real-World Payments, Developer Infrastructure & Tooling). Required at submission: GitHub
repo link, live demo URL, a deployed contract address **on QIE Mainnet** (chain 1990 — build
and test on Testnet, chain 1983, but mainnet deployment is the submission requirement, not
testnet), and the chosen track. Prize pool $17,000 total, 50%-now / 50%-after-90-days-traction
payout.

### Submission checklist

| Requirement | Value |
|---|---|
| **GitHub source** | https://github.com/caelum0x/cred402 |
| **Track selection** | AI & Autonomous Agents |
| **Demo video** | **TODO** — record once a real facilitator + QUSDC contract are configured (see [Produce the required submission artifacts](#produce-the-required-submission-artifacts)) |
| **Live demo URL** | `GET /v1/x402/qie/credit-score/:agentId` on https://cred402-1.onrender.com is live code today, but returns `503` until an operator sets `CRED402_QIE_PAY_TO` / `CRED402_QIE_ASSET_ADDRESS` / `CRED402_QIE_FACILITATOR_URL` on that deployment — see [below](#what-was-newly-built-vs-whats-todo) |
| **Deployed contract address on QIE Mainnet** | **TODO** — not deployed; see [Mainnet release checklist](qie_x402.md#mainnet-release-checklist) in the QIE integration doc |
| **A real testnet/mainnet transaction** | **TODO** — needs a funded QIE faucet key, a confirmed QUSDC contract, and a running x402 EVM facilitator for QIE; none of the three is confirmed to exist yet (see below) |

### What it is

Cred402's QIE integration follows the same shape as every other chain integration in this
repo: it sells one resource, the agent credit score, over x402, and keeps the scoring and
risk logic shared with the rest of the protocol. QIE is EVM-compatible (a Cosmos-SDK chain
with standard `eth_*` JSON-RPC, the same general shape as Flare), so the integration is meant
to extend Cred402's generic EVM x402 primitives rather than duplicate Algorand's bespoke
non-EVM indexer/ASA logic. Full write-up, configuration, and the honest list of what's
unverified: [`qie_x402.md`](qie_x402.md).

### What was newly built vs. what's TODO

- **Shipped, real code (not a stub):** `GET /v1/x402/qie/credit-score/:agentId`
  (`api/qie_x402_routes.ts`) and `GET /v1/x402/qie/status`, backed by
  `lib/x402/qie_gateway.ts` (the `@x402/core` + `@x402/evm` `ExactEvmScheme` resource server —
  the same chain-agnostic plumbing the Algorand route uses), `lib/x402/qie_networks.ts`
  (`eip155:1983` / `eip155:1990`), `lib/x402/qie_rpc.ts` + `qie_finality.ts` (independent
  on-chain settlement confirmation via QIE's own RPC — no Indexer-equivalent is confirmed to
  exist for QIE, so Cred402 reads the transaction receipt and ERC-20 `Transfer` log itself),
  and `lib/x402/qie_payment_attempt_store.ts` (durable exact-once replay, mirroring
  `AlgorandPaymentAttemptStore`). `npm run x402:qie:check` is the live, read-only preflight
  script (`scripts/qie_x402_check.ts` + `lib/x402/qie_client.ts`). 9 new tests
  (`test/qie_x402.test.ts`) cover config fail-closing, the unpaid challenge shape, the client
  selector, the attempt store, and both finality outcomes; `npm test` and `npm run typecheck`
  are green with this code in the tree. Full write-up: [`qie_x402.md`](qie_x402.md).
- **Casper-anchoring: now built.** `api/qie_receipt_anchor.ts` mirrors
  `algorand_receipt_anchor.ts` exactly — a settled QIE payment becomes the same
  Casper-rooted Universal Receipt Envelope used by every other satellite chain
  (`qie:<payer>` identity, `qie-erc20:<contract>` asset id), anchored provisional
  (`finalize: false`) until `reconcileQiePayment`'s RPC check confirms it, then
  finalized or challenged exactly like the Algorand path. Wired into
  `api/state.ts` (`anchorQieCreditScoreSettlement` /
  `finalizeQieExternalReceipt` / `challengeQieExternalReceipt` /
  `qieX402Usage`) and `api/qie_x402_routes.ts` (the credit-score response now
  carries `external_receipt_id`, `external_receipt_url`, and
  `casper_anchor_status`, served through the same
  `/v1/x402/external-receipts/:id` endpoint Algorand uses — receipt ids are a
  shared, chain-agnostic content hash). 6 new unit tests
  (`test/qie_receipt_anchor.test.ts`) exercise the anchor function directly
  against a real `Ledger` (idempotent replay, conflicting-replay rejection,
  finalize/challenge transitions, and usage aggregation); `npm test` (408/408)
  and `npm run typecheck` stay green.
- **Deliberately fails closed, not invented:** `CRED402_QIE_ASSET_ADDRESS` (QUSDC's ERC-20
  contract address on QIE could not be independently confirmed by research — the route
  returns `503` rather than guessing one) and `CRED402_QIE_FACILITATOR_URL` (no default x402
  EVM facilitator for QIE is confirmed to exist — an operator must point this at a self-hosted
  or third-party one). Both are required env vars with no default; `CRED402_QIE_PAY_TO` is
  required the same way `CRED402_ALGORAND_PAY_TO` is. See
  [What research could not confirm](qie_x402.md#what-research-could-not-confirm-and-how-the-code-fails-closed-instead)
  in the integration doc.
- **Not yet built (tracked, not hidden):** Casper-anchoring of QIE settlements (the Algorand
  route anchors a receipt proof to Casper; QIE's is durable locally but not yet anchored), and
  the balance-readiness / signed-evidence release-check scripts that Algorand has
  (`x402:algorand:ready`, `x402:algorand:release-check`) — add these once a real facilitator
  and the QUSDC contract address are confirmed and testable end-to-end. See
  [Known gaps](qie_x402.md#known-gaps-vs-the-algorand-integration-tracked-not-hidden).
- **TODO (needs owner-held keys/accounts, not code):** a deployed contract address on QIE
  Mainnet, a real testnet or mainnet transaction, a demo video, and a live demo URL with the
  env vars above actually set on the production deployment.

### Produce the required submission artifacts

The adapter code is done; what remains needs a real key, a confirmed QUSDC contract, and a
running facilitator — none of which can be faked:

```bash
# 1. Fund a testnet QIE key from the faucet (testnet QIE only, never asks for a seed phrase):
#    https://www.qie.digital/faucet
# 2. Confirm (or deploy, for local development) a QUSDC/test ERC-20 contract address on QIE
#    testnet, and stand up or point at an x402 EVM facilitator that settles "exact" payments
#    on eip155:1983. Then run the live, read-only preflight check (never signs or pays):
export CRED402_QIE_EXPECTED_PAY_TO=0x...
export CRED402_QIE_EXPECTED_ASSET_ADDRESS=0x...
npm run x402:qie:check -- "https://staging.example.com/v1/x402/qie/credit-score/$CRED402_AGENT_ID"

# 3. Before the Nov 30, 2026 deadline, deploy to QIE Mainnet (chain 1990) and record the
#    contract address and a real transaction hash in docs/qie_x402.md's release checklist.
```

Without a key, there is no sim fallback documented for this one the way `npm run
submit:check` has one for KeeperHub × Flare — the QIE submission's required artifacts
(live demo URL, deployed mainnet contract, transaction) are inherently real-network
deliverables, not something a deterministic sim can stand in for at submission time.

---

## 4. Reproduce everything

Every flow runs sim-by-default (no keys, no network). Real integrations activate behind env
vars (see [What's real vs sim](#4-whats-real-vs-sim)).

| Command | What it runs |
|---|---|
| `npm run demo:grand` | **The whole arc in one run** (`scripts/grand_demo.ts`): earn x402 → confidential score → draw FXRP via KeeperHub → FTSO mark + keeper deleverage → declare an automation → post multi-asset collateral → mint FXRP from attested XRP → sell a credit service over x402 → scheduler runs the last mile on a cadence. **This is the script to screen-record.** |
| `npm run flare:credit` | Flare credit loop (`scripts/flare_credit.ts`): x402 revenue → FDC attests → Confidential Compute scores → Casper signs a CAN → vault lends 500 FXRP priced by FTSO → KeeperHub executes → repay + reliability rollup. |
| `npm run keeperhub:execute` | Run one intent through KeeperHub's full envelope (`scripts/keeperhub_execute.ts`): intent → simulate → smart gas + backoff → private routing → tx hash → audit. Real tx with `KEEPERHUB_API_KEY`. |
| `npm run keeper:run` | Autonomous Credit Keeper (`scripts/keeper_run.ts`): margin call at HF 1.13 → deleverage ~2,089 FXRP via KeeperHub → cured at HF 1.50 → 2× stress test. |
| `npm run automations:run` | Credit Automations (`scripts/automations_run.ts`): declare 2 rules → margin call → tick fires → cured → idempotent second tick. |
| `npm run collateral:run` | FTSO-priced collateral (`scripts/collateral_run.ts`): margin call → post USDC/BTC/ETH → cured with no repay → stress test. |
| `npm run x402:market` | Credit-Service Marketplace (`scripts/x402_market_run.ts`): catalog → `402` → sign → `200` → replay-rejected → revenue rollup. |
| `npm run fassets:mint` | FAssets mint → collateralize (`scripts/fassets_mint_run.ts`): reserve 5,000 XRP → FDC-attested mint 5,000 FXRP → post as collateral (power 0 → 1,560 USD) → redeem 1,000. |
| `npm run scheduler:run` | Autonomous Scheduler (`scripts/scheduler_run.ts`): deterministic cadence over a simulated timeline — keeper-sweep @60s + automation-tick @30s, with the overlap guard and no-op safety. |
| `npm test` | The full suite (`tsx --test test/*.test.ts`) — **346 pass**, sim, no keys. |
| `npm run submit:check` | Submission readiness (`scripts/submission_check.ts`): runs the KeeperHub × Flare pipeline in sim and prints, per hackathon, requirements + what's satisfied + the exact commands for the two remaining artifacts. |
| `npm run record:hackathon` | Regenerate the demo video (`scripts/record_hackathon_demo.mjs`) → [`media/cred402-hackathon-demo.mp4`](../media/cred402-hackathon-demo.mp4). |

---

## 5. What's real vs sim

Cred402's convention is **real-behind-env + deterministic sim**: everything runs green in a
deterministic simulation with **no keys** (so `npm test` → 346 pass on any machine and every
demo above works offline), and each real integration activates only when its env var is
present. The return shapes are identical either way — only the price feed, attestation source,
and transaction broadcast differ.

| Integration | Activates when | Sim default |
|---|---|---|
| **KeeperHub MCP execution** | `KEEPERHUB_API_KEY` set → MCP-over-HTTP to `https://app.keeperhub.com/mcp`, real tx hash | Deterministic execution + identical audit trail |
| **KeeperHub workflow registration** | `KEEPERHUB_API_KEY` → `create_workflow` (+ `validate_cron`) | Automation is local-only, fully functional |
| **KeeperHub gas sponsorship** | `KEEPERHUB_GAS_SPONSORSHIP=1` (mainnet ETH, chain 1) | Agent pays via x402/MPP |
| **FTSO pricing** | `FLARE_RPC_URL` → `FtsoV2.getFeedById` `eth_call` (FtsoV2 from the registry) | Deterministic reference prices (`XRP/USD = $0.52`); RPC failure degrades to sim |
| **FDC attestation** | `FLARE_FDC_VERIFIER_URL` → `POST …/Payment/prepareRequest` (`status:"VALID"` → verified) | Deterministic verified envelope; live path is fail-closed (unverified → no mint) |
| **Confidential Compute** | `FLARE_CC_ATTESTATION_URL` → enclave remote-attestation quote | `sim-tee` deterministic quote over the same commitments |
| **FAssets AssetManager** | `FLARE_RPC_URL` + `FLARE_FXRP_ASSET_MANAGER` → `reserveCollateral` / `executeMinting` | Deterministic in-memory reservation state machine |
| **On-chain vault** | `Cred402FlareCreditVault.sol` deployed to Coston2 | `FlareSatelliteVault.ts` twin, rule-for-rule |
| **x402 facilitator settlement** | `CRED402_X402_FACILITATOR_URL` → `make-software/casper-x402` (V2) | Local verify + receipt (signatures are always real ed25519 over EIP-712) |

The security invariants — CAN verification, single-use nonce, USD-denominated exposure cap,
the "only ever repay existing debt" keeper safety rule, the FAssets 1:1 mint / fail-closed
attestation rule, and the Confidential Compute privacy invariant — are **enforced identically
in both modes**.

---

## References

- KeeperHub execution layer: [`keeperhub_integration.md`](keeperhub_integration.md)
- Flare satellite (both bounties): [`flare_integration.md`](flare_integration.md)
- Autonomous Credit Keeper (FTSO risk → KeeperHub execution): [`credit_keeper.md`](credit_keeper.md)
- Credit Automations (workflow + cron): [`credit_automations.md`](credit_automations.md)
- FTSO-priced collateral: [`collateral.md`](collateral.md)
- FAssets mint → collateralize: [`fassets.md`](fassets.md)
- x402 Credit-Service Marketplace: [`x402_marketplace.md`](x402_marketplace.md)
- Autonomous Scheduler (cron cadence): [`scheduler.md`](scheduler.md)
- On-chain vault + deploy: [`../contracts/flare/README.md`](../contracts/flare/README.md)
- Readiness report: `npm run submit:check` (`scripts/submission_check.ts`)
