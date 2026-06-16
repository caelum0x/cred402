"""ToolRouter — the only thing that touches the live Cred402 API.

Every tool the agent can use is a method on :class:`ToolRouter`. No tool runs
directly; the agent proposes an :class:`~orchestrator.policy.Action`, the router
runs it through the :class:`~orchestrator.policy.PolicyEngine` FIRST, audits the
decision, executes only if allowed, then audits the outcome and reports it back
to the engine (so spending windows / circuit breakers update from reality).

Tools wrap the local ``cred402`` SDK (``cred402.Client``):

* ``get_passport``     — GET agent passport (read).
* ``explain_credit``   — GET credit-explain (read).
* ``open_credit_line`` — POST underwrite + open a line.
* ``draw_credit``      — POST draw from the line (a SPEND).
* ``repay_credit``     — POST repay.
* ``buy_evidence``     — the real x402 402 -> sign (ed25519) -> 200 flow (a SPEND).
* ``verify_operator``  — POST a RealFi operator verification attestation.

The router is deliberately thin: it does NOT decide whether an action is
allowed (that is the engine's job) — it only enforces the verdict.
"""

from __future__ import annotations

import base64
import json
import uuid
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Callable, Dict, Mapping, Optional

from . import ed25519
from .audit import AuditLog
from .policy import Action, PolicyEngine, PolicyResult


class ToolError(Exception):
    """Raised when a tool's underlying live call fails."""


class PolicyBlocked(Exception):
    """Raised when the policy engine refuses to let an action execute."""

    def __init__(self, result: PolicyResult) -> None:
        super().__init__(result.summary)
        self.result = result


@dataclass(frozen=True)
class ToolResult:
    """The outcome of a routed tool call."""

    tool: str
    policy: PolicyResult
    executed: bool
    success: bool
    data: Mapping[str, Any]
    error: Optional[str] = None


# The complete catalog of tool names this router exposes. Used by agents to
# build their allowlists and by the planner to name actions.
TOOL_NAMES = (
    "register_agent",
    "get_passport",
    "explain_credit",
    "open_credit_line",
    "draw_credit",
    "repay_credit",
    "buy_evidence",
    "verify_operator",
)


class ToolRouter:
    """Routes tool calls through policy + audit and onto the live API.

    Args:
        client: a ``cred402.Client`` bound to the live API.
        engine: the agent's policy engine.
        audit: append-only audit log.
        agent_id: the acting agent's id (used for ledger calls + audit).
        signing_seed: the agent's ed25519 signing seed for x402 (bytes or str).
        clock: injectable time source for idempotency keys / timing.
    """

    def __init__(
        self,
        *,
        client: Any,
        engine: PolicyEngine,
        audit: AuditLog,
        agent_id: str,
        signing_seed: bytes | str,
        goal: str = "",
    ) -> None:
        self._client = client
        self._engine = engine
        self._audit = audit
        self._agent_id = agent_id
        self._goal = goal
        self._seed = signing_seed.encode("utf-8") if isinstance(signing_seed, str) else bytes(signing_seed)
        self._step = 0
        # Track the live credit line so draw/repay know the line_id (== agent_id).
        self.line_id: Optional[str] = None

    @property
    def public_key_hex(self) -> str:
        return ed25519.casper_public_key_hex(self._seed)

    # -- core routing ------------------------------------------------------- #

    def _idem(self) -> str:
        return f"{self._agent_id}-{uuid.uuid4().hex[:12]}"

    def execute(self, action: Action, runner: Callable[[], Mapping[str, Any]]) -> ToolResult:
        """Gate ``action`` through the engine, audit, run ``runner`` if allowed,
        audit the outcome, and report it back to the engine."""
        self._step += 1
        result = self._engine.evaluate(action)
        decisions = [
            {"policy": d.policy, "verdict": d.verdict.value, "reason": d.reason}
            for d in result.decisions
        ]

        if not result.allowed:
            # Blocked or pending: audit the refusal, do NOT execute.
            self._audit.append(
                agent_id=self._agent_id,
                goal=self._goal,
                step=self._step,
                tool=action.tool,
                description=action.description,
                amount_cspr=str(action.amount_cspr),
                verdict=result.deciding.verdict.value,
                deciding_policy=result.deciding.policy,
                reason=result.deciding.reason,
                decisions=decisions,
                executed=False,
                success=None,
                outcome={},
            )
            return ToolResult(
                tool=action.tool,
                policy=result,
                executed=False,
                success=False,
                data={},
                error=result.summary,
            )

        # Allowed -> execute against the live API.
        success = False
        data: Mapping[str, Any] = {}
        error: Optional[str] = None
        try:
            data = runner()
            success = True
        except Exception as exc:  # surface as a real, audited failure
            error = f"{type(exc).__name__}: {exc}"
            data = {}
            success = False

        self._engine.report_outcome(action, success)
        self._audit.append(
            agent_id=self._agent_id,
            goal=self._goal,
            step=self._step,
            tool=action.tool,
            description=action.description,
            amount_cspr=str(action.amount_cspr),
            verdict=result.deciding.verdict.value,
            deciding_policy=result.deciding.policy,
            reason=result.deciding.reason,
            decisions=decisions,
            executed=True,
            success=success,
            outcome=dict(data) if success else {"error": error},
        )
        return ToolResult(
            tool=action.tool,
            policy=result,
            executed=True,
            success=success,
            data=data,
            error=error,
        )

    # -- tools (each builds an Action then routes it) ----------------------- #

    def register_agent(self, *, service_type: str) -> ToolResult:
        """Ensure the agent exists on the protocol (real POST /v1/agents).

        Idempotent at the protocol level via the idempotency key; a re-register
        of an existing agent is treated as success so monitoring can proceed."""
        action = Action.make(
            "register_agent",
            description=f"register {self._agent_id} as {service_type}",
            params={"service_type": service_type},
        )

        def run() -> Dict[str, Any]:
            try:
                passport = self._client.agents.register(
                    self._agent_id, service_type, idempotency_key=self._idem()
                )
                return {"agent_id": passport.agent_id, "registered": True}
            except Exception as exc:  # already-registered / conflict is fine
                msg = str(exc).lower()
                if "exist" in msg or "conflict" in msg or "already" in msg:
                    return {"agent_id": self._agent_id, "registered": False, "note": "already registered"}
                raise

        return self.execute(action, run)

    def get_passport(self) -> ToolResult:
        action = Action.make("get_passport", description=f"read passport for {self._agent_id}")

        def run() -> Dict[str, Any]:
            p = self._client.agents.passport(self._agent_id)
            return {
                "agent_id": p.agent_id,
                "reputation_score": p.reputation_score,
                "credit_score": p.credit_score,
                "credit_limit_cspr": str(p.credit_limit_cspr),
                "outstanding_debt_cspr": str(p.outstanding_debt_cspr),
                "dispute_rate": p.dispute_rate,
                "total_receipts": p.total_receipts,
            }

        return self.execute(action, run)

    def explain_credit(self) -> ToolResult:
        action = Action.make("explain_credit", description=f"underwriting explain for {self._agent_id}")

        def run() -> Dict[str, Any]:
            ex = self._client.credit.explain(self._agent_id)
            return {
                "eligible": bool(ex.raw.get("eligible", False)),
                "credit_score": ex.decision.credit_score,
                "credit_line_cspr": str(ex.decision.credit_line_cspr),
                "interest_rate_pct": ex.decision.interest_rate_pct,
                "fraud_score": ex.fraud_score,
                "reason_codes": [
                    {"code": r.code, "polarity": r.polarity, "detail": r.detail}
                    for r in ex.reason_codes
                ],
            }

        return self.execute(action, run)

    def open_credit_line(self, *, term_days: Optional[int] = None) -> ToolResult:
        action = Action.make("open_credit_line", description=f"open credit line for {self._agent_id}")

        def run() -> Dict[str, Any]:
            decision, line = self._client.credit.open_line(
                self._agent_id, term_days=term_days, idempotency_key=self._idem()
            )
            self.line_id = line.agent_id or self._agent_id
            return {
                "line_id": self.line_id,
                "max_credit_cspr": str(line.max_credit_cspr),
                "drawn_cspr": str(line.drawn_cspr),
                "available_cspr": str(line.available_cspr),
                "interest_rate_pct": line.interest_rate_pct,
                "status": line.status,
                "decision_credit_line_cspr": str(decision.credit_line_cspr),
            }

        return self.execute(action, run)

    def draw_credit(self, amount_cspr: float) -> ToolResult:
        action = Action.make(
            "draw_credit",
            description=f"draw {amount_cspr} CSPR from credit line",
            amount_cspr=amount_cspr,
        )
        line_id = self.line_id or self._agent_id

        def run() -> Dict[str, Any]:
            line = self._client.credit.draw(line_id, float(amount_cspr), idempotency_key=self._idem())
            return {
                "line_id": line_id,
                "drawn_cspr": str(line.drawn_cspr),
                "available_cspr": str(line.available_cspr),
                "max_credit_cspr": str(line.max_credit_cspr),
                "health_factor": line.health_factor,
                "status": line.status,
            }

        return self.execute(action, run)

    def repay_credit(self, amount_cspr: float) -> ToolResult:
        action = Action.make(
            "repay_credit",
            description=f"repay {amount_cspr} CSPR to credit line",
        )
        line_id = self.line_id or self._agent_id

        def run() -> Dict[str, Any]:
            res = self._client.credit.repay(line_id, float(amount_cspr), idempotency_key=self._idem())
            line = res["line"]
            return {
                "line_id": line_id,
                "drawn_cspr": str(line.drawn_cspr),
                "available_cspr": str(line.available_cspr),
                "interest_motes": res["interest_motes"],
                "status": line.status,
            }

        return self.execute(action, run)

    def buy_evidence(
        self,
        *,
        evidence_type: str = "energy_output",
        rwa_id: str = "SOLAR-A17",
    ) -> ToolResult:
        """The real x402 flow: 402 challenge -> ed25519-signed proof -> 200 report.

        The spend amount is read from the live 402 challenge BEFORE the action is
        gated, so the spending limit / approval gate evaluate the true cost."""
        path = f"/verify/{evidence_type}?rwa_id={rwa_id}&buyer={self._agent_id}"

        # Fetch the 402 challenge first to learn the real price. This read is
        # cheap and not itself a spend; the SPEND is the paid retry.
        try:
            status, headers, body = self._client.raw_request_with_headers("GET", path)
        except Exception as exc:
            # Build a zero-cost action just so the failure is audited coherently.
            action = Action.make("buy_evidence", description=f"x402 buy {evidence_type} (challenge failed)")
            return self.execute(action, lambda: (_ for _ in ()).throw(ToolError(f"402 challenge failed: {exc}")))

        from cred402.x402 import PaymentChallenge  # local import: SDK on sys.path

        challenge = PaymentChallenge.from_headers(headers, body)
        amount_cspr = Decimal(challenge.amount_motes or "0") / Decimal(1_000_000_000)
        action = Action.make(
            "buy_evidence",
            description=f"x402 buy {evidence_type} for {rwa_id} ({amount_cspr} CSPR)",
            amount_cspr=amount_cspr,
            params={"evidence_type": evidence_type, "rwa_id": rwa_id, "payment_id": challenge.payment_id},
        )

        def run() -> Dict[str, Any]:
            header = self._build_x402_header(challenge)
            st, _h, paid = self._client.raw_request_with_headers(
                "GET", path, headers={"X-Payment": header}
            )
            if st != 200:
                err = paid.get("error") if isinstance(paid, Mapping) else paid
                raise ToolError(f"x402 paid request returned HTTP {st}: {err}")
            report = paid.get("report", {}) if isinstance(paid, Mapping) else {}
            return {
                "http_status": st,
                "payment_id": challenge.payment_id,
                "amount_cspr": str(amount_cspr),
                "seller_agent": challenge.seller_agent,
                "receipt_id": paid.get("receipt_id"),
                "evidence_id": paid.get("evidence_id"),
                "confidence": report.get("confidence"),
                "evidence_hash": report.get("evidence_hash"),
            }

        return self.execute(action, run)

    def _build_x402_header(self, challenge: Any) -> str:
        """Build the base64 X-Payment header with a REAL ed25519 signature over
        the canonical authorization (matches the server's verifyCasperHex)."""
        authorization = {
            "domain": {"name": "Cred402", "version": "1", "network": "casper-testnet"},
            "payment_id": challenge.payment_id,
            "payer_agent": self._agent_id,
            "seller_agent": challenge.seller_agent,
            "service_type": challenge.service_type,
            "amount_motes": challenge.amount_motes,
            "resource": challenge.resource,
            "nonce": challenge.nonce,
        }
        message = json.dumps(authorization, sort_keys=True, separators=(",", ":")).encode("utf-8")
        signature = ed25519.sign(message, self._seed).hex()
        proof = {
            "authorization": authorization,
            "payer_public_key": self.public_key_hex,
            "signature": signature,
        }
        return base64.b64encode(json.dumps(proof).encode("utf-8")).decode("ascii")

    def verify_operator(
        self,
        *,
        operator_id: str,
        verification_reference: str,
        verification_level: str = "business_verified",
        jurisdiction: str = "US",
    ) -> ToolResult:
        action = Action.make(
            "verify_operator",
            description=f"attest operator {operator_id} ({verification_level})",
            params={"operator_id": operator_id},
        )

        def run() -> Dict[str, Any]:
            res = self._client.realfi.verify_operator(
                operator_id,
                verification_level=verification_level,
                jurisdiction=jurisdiction,
                verification_reference=verification_reference,
                idempotency_key=self._idem(),
            )
            return {
                "operator_id": operator_id,
                "attestation_hash": res.get("attestation_hash"),
                "verification_status": (res.get("envelope") or {}).get("verification_status"),
            }

        return self.execute(action, run)
