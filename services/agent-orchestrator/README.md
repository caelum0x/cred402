# Cred402 Agent Orchestrator

A **production-quality autonomous-agent runtime** for the [Cred402](../../PRODUCTION.md)
protocol. Agents SPEND (x402 evidence purchases), EARN (revenue/receipts),
ATTEST (RealFi operator verifications), BORROW (credit lines) and REACT to live
protocol state — but **every action is forced through a policy engine that sits
OUTSIDE the proposer**.

> The LLM proposes. The policy engine disposes. — Cred402 prompt-injection mitigation (see `SECURITY.md`)

This runtime runs **for real** against the live Cred402 API
(`http://localhost:4021`) using the local Python SDK (`from cred402 import
Client`). No mocks, no placeholders. Standard library only (plus the SDK), Python 3.10+.

---

## The safety model: proposer / disposer split

```
                 proposes                      disposes (ALL must pass)
  ┌──────────┐   a plan of   ┌──────────────┐   ┌───────────────────────────┐
  │ Planner  │ ───────────►  │ ToolRouter   │──►│ PolicyEngine.evaluate()   │
  │ (rules / │   tool calls  │ (the ONLY    │   │  • ToolPermissions        │
  │  an LLM) │               │  thing that  │   │  • SpendingLimit          │
  └──────────┘               │  hits the    │   │  • ApprovalGate           │
                             │  live API)   │   │  • CircuitBreaker         │
                             └──────┬───────┘   └────────────┬──────────────┘
                                    │ allowed?                │
                                    ▼                          ▼
                             live Cred402 API           append-only audit log
```

The **planner is the slot an LLM would occupy**. Here it is deliberately a
deterministic, rule-based planner ([`planner.py`](orchestrator/planner.py)) so
the demo is reproducible and auditable — but swapping in an LLM changes only
that file. Everything downstream is unchanged: the policy engine still disposes
of whatever is proposed, so a prompt-injected "drain the credit line"
instruction is refused by the engine regardless of what the proposer wanted.

**Key property:** the policy engine cannot be talked out of its decision. It is
not in the prompt, not in the context, and not reachable by the proposer. A tool
call executes only if **every** policy returns `ALLOW`.

---

## Components

| File | Role |
|------|------|
| [`orchestrator/policy.py`](orchestrator/policy.py) | The real policy engine: `SpendingLimit`, `ToolPermissions`, `CircuitBreaker`, `ApprovalGate`, composed into `PolicyEngine`. Each returns an immutable typed `Decision(allow, reason)`. |
| [`orchestrator/audit.py`](orchestrator/audit.py) | Append-only JSONL audit log — every proposed action + policy decision + outcome, flushed and `fsync`'d. Queryable in-process and on disk. |
| [`orchestrator/tools.py`](orchestrator/tools.py) | `ToolRouter` wrapping the SDK. Tools: `get_passport`, `explain_credit`, `open_credit_line`, `draw_credit`, `repay_credit`, `buy_evidence` (real x402), `verify_operator`, `register_agent`. Every call goes through the engine first and is audited. |
| [`orchestrator/ed25519.py`](orchestrator/ed25519.py) | Pure-stdlib RFC 8032 Ed25519 — needed because the server verifies x402 proofs with real Ed25519 (`verifyCasperHex`). Interop verified live. |
| [`orchestrator/planner.py`](orchestrator/planner.py) | Deterministic rule-based planner with real branching on live state. |
| [`orchestrator/agent.py`](orchestrator/agent.py) | `Agent` binding identity + budget + engine + router + planner, with a real `run(goal)` loop that stops on a blocked/critical step. |
| [`orchestrator/agents/credit_agent.py`](orchestrator/agents/credit_agent.py) | Obtains + draws + repays credit; allowlist permits spend tools but limits cap them. |
| [`orchestrator/agents/treasury_agent.py`](orchestrator/agents/treasury_agent.py) | Monitors + attests; allowlist **excludes** spend tools so it can never draw/buy. |
| [`run.py`](run.py) | CLI that seeds the demo, builds the agent, runs the goal live, and prints plan + decisions + outcomes + audit summary. |

### The four policies

* **`SpendingLimit`** — a per-action cap *and* a rolling-window total cap.
  Spends only commit to the window on a real successful outcome, so a blocked or
  failed action never consumes budget.
* **`ToolPermissions`** — a per-agent allowlist of tool names. The canonical
  prompt-injection defense.
* **`CircuitBreaker`** — trips after *N* real failures within a window and blocks
  all calls until a cooldown elapses; a success resets it.
* **`ApprovalGate`** — actions at/above a CSPR threshold return `PENDING`
  (held, not executed) unless explicitly `approved`.

`PolicyEngine.evaluate(action)` runs all four and allows only if **all** pass.

---

## Usage

Start the live API first (from the repo root):

```bash
npm start            # tsx api/server.ts on http://localhost:4021
```

Then run an agent:

```bash
# borrow: plan -> open a line -> attempt a draw that the SpendingLimit BLOCKS
python3 services/agent-orchestrator/run.py credit borrow

# earn: the real x402 402 -> Ed25519-signed proof -> 200 evidence purchase
python3 services/agent-orchestrator/run.py credit earn

# treasury: self-register -> monitor -> attest an operator (no spend tools allowed)
python3 services/agent-orchestrator/run.py treasury fund
```

Options: `--base-url URL`, `--no-seed` (skip `POST /api/demo/run`),
`--audit-path PATH`.

### What a run prints

1. The **policy engine config** (limits, allowlist, breaker state).
2. The **plan** the planner proposed for the goal.
3. **Each step's execution**, with **every policy's decision** (`ALLOW` / `BLOCK`
   / `PENDING`) and the live API outcome.
4. A **final audit summary** read back from the JSONL log, listing any `BLOCK`ed
   actions as proof the engine enforced limits.

### Demonstrated enforcement (`credit borrow`)

The credit agent's per-action spend cap is **3 CSPR**, but the planner proposes a
**5 CSPR** draw. The engine blocks it and the run halts:

```
  4. [BLOCK  ] draw_credit      NOT EXECUTED (BLOCK) :: BLOCK [spending_limit] spend 5.0 CSPR exceeds per-action cap 3 CSPR
       [+] tool_permissions   ALLOW   tool 'draw_credit' on allowlist
       [x] spending_limit     BLOCK   spend 5.0 CSPR exceeds per-action cap 3 CSPR
       [+] approval_gate      ALLOW   spend 5.0 CSPR below approval threshold
       [+] circuit_breaker    ALLOW   circuit closed
  RUN STOPPED: step 4 (draw_credit) BLOCK: spend 5.0 CSPR exceeds per-action cap 3 CSPR
```

The treasury agent goes further: its allowlist has **no** `draw_credit` /
`buy_evidence` at all, so a prompt-injected spend would be refused by
`ToolPermissions` before any limit is even consulted.

---

## Audit log

Every run writes [`audit_log.jsonl`](.) — one JSON object per line:

```json
{"seq":6,"ts":...,"agent_id":"EvidenceSellerAgent","goal":"borrow","step":6,
 "tool":"draw_credit","amount_cspr":"5.0","verdict":"BLOCK",
 "deciding_policy":"spending_limit","reason":"spend 5.0 CSPR exceeds per-action cap 3 CSPR",
 "decisions":[...],"executed":false,"success":null,"outcome":{}}
```

It is append-only and `fsync`'d per record, and queryable via
`AuditLog.query(agent_id=..., verdict=..., executed=...)` and `AuditLog.summary()`.

---

## Notes on the x402 flow

The paid-evidence server (`api/paid_evidence_server`) verifies payment proofs
with **real Ed25519** over the canonical authorization bytes. The Python SDK's
`build_payment_proof` uses HMAC (a stand-in), which the server rejects. So
`buy_evidence` signs with a genuine Ed25519 key produced by the pure-stdlib
[`ed25519.py`](orchestrator/ed25519.py) module — the resulting signature passes
the server's `verifyCasperHex`, yielding a real `HTTP 200` signed report and an
on-ledger receipt. The signing module is textbook (not constant-time): fine for
signing low-value local demo payments, not for guarding production secrets.
