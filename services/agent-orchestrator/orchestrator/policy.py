"""The policy engine — the part that sits OUTSIDE the proposer.

p4, Attack 4 (prompt injection):

    > The LLM proposes. The policy engine disposes.

A planner (or an LLM) may *propose* any action it likes. Before a single tool
call touches the live Cred402 API, the proposed :class:`Action` is run through
every policy in a :class:`PolicyEngine`. ALL policies must return ``allow``;
if any blocks (or defers to approval), the action does not execute. This module
contains the real, stateful enforcement primitives:

* :class:`SpendingLimit`     — per-action cap + rolling-window total cap.
* :class:`ToolPermissions`   — per-agent allowlist of tool names.
* :class:`CircuitBreaker`    — trips after N failures in a window; cools down.
* :class:`ApprovalGate`      — actions above a threshold require approval.

Everything here is pure standard library and deterministic given its inputs and
the injected clock, so it is trivially testable and auditable. Decisions are
immutable :class:`Decision` values. State (spend windows, breaker failures) is
held in memory on the policy instances and mutated only through their methods —
the rest of the system treats policies as opaque evaluators.
"""

from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from decimal import Decimal
from enum import Enum
from typing import Callable, Deque, Dict, List, Mapping, Optional, Tuple


# --------------------------------------------------------------------------- #
# Core value types
# --------------------------------------------------------------------------- #


class Verdict(str, Enum):
    """The three outcomes a policy can return."""

    ALLOW = "ALLOW"
    BLOCK = "BLOCK"
    PENDING = "PENDING"  # needs out-of-band approval before it may run


@dataclass(frozen=True)
class Decision:
    """An immutable policy decision.

    ``allow`` is True only for :attr:`Verdict.ALLOW`. ``PENDING`` is *not* an
    allow — the action is held, not executed — but it is distinguishable from a
    hard ``BLOCK`` so a human/approver loop can resolve it.
    """

    verdict: Verdict
    policy: str
    reason: str

    @property
    def allow(self) -> bool:
        return self.verdict is Verdict.ALLOW

    @property
    def pending(self) -> bool:
        return self.verdict is Verdict.PENDING

    @property
    def blocked(self) -> bool:
        return self.verdict is Verdict.BLOCK

    @classmethod
    def allow_(cls, policy: str, reason: str = "ok") -> "Decision":
        return cls(Verdict.ALLOW, policy, reason)

    @classmethod
    def block(cls, policy: str, reason: str) -> "Decision":
        return cls(Verdict.BLOCK, policy, reason)

    @classmethod
    def pending_(cls, policy: str, reason: str) -> "Decision":
        return cls(Verdict.PENDING, policy, reason)


@dataclass(frozen=True)
class Action:
    """A *proposed* action — what the planner/LLM wants the agent to do.

    ``tool`` is the tool name (must be on the agent's allowlist). ``amount_cspr``
    is the spend the action would incur (0 for read-only tools). ``approved``
    is set True only when a human/approver has explicitly signed off, letting it
    pass the :class:`ApprovalGate`.
    """

    tool: str
    description: str = ""
    amount_cspr: Decimal = Decimal(0)
    params: Mapping[str, object] = field(default_factory=dict)
    approved: bool = False

    @classmethod
    def make(
        cls,
        tool: str,
        *,
        description: str = "",
        amount_cspr: object = 0,
        params: Optional[Mapping[str, object]] = None,
        approved: bool = False,
    ) -> "Action":
        return cls(
            tool=tool,
            description=description,
            amount_cspr=Decimal(str(amount_cspr)),
            params=dict(params or {}),
            approved=approved,
        )

    @property
    def is_spend(self) -> bool:
        return self.amount_cspr > 0


@dataclass(frozen=True)
class PolicyResult:
    """Aggregate result of running an action through every policy."""

    action: Action
    decisions: Tuple[Decision, ...]

    @property
    def allowed(self) -> bool:
        """True only if every policy allowed (no BLOCK, no PENDING)."""
        return all(d.allow for d in self.decisions)

    @property
    def pending(self) -> bool:
        """True if nothing blocked but at least one policy deferred to approval."""
        return (not self.blocked) and any(d.pending for d in self.decisions)

    @property
    def blocked(self) -> bool:
        return any(d.blocked for d in self.decisions)

    @property
    def deciding(self) -> Decision:
        """The decision that determined the outcome (first block, else first
        pending, else the last allow)."""
        for d in self.decisions:
            if d.blocked:
                return d
        for d in self.decisions:
            if d.pending:
                return d
        return self.decisions[-1]

    @property
    def summary(self) -> str:
        return f"{self.deciding.verdict.value} [{self.deciding.policy}] {self.deciding.reason}"


# --------------------------------------------------------------------------- #
# Individual policies
# --------------------------------------------------------------------------- #

Clock = Callable[[], float]


class Policy:
    """Base class. A policy inspects an :class:`Action` and returns a
    :class:`Decision`. Policies may hold mutable state across evaluations."""

    name = "policy"

    def evaluate(self, action: Action) -> Decision:  # pragma: no cover - abstract
        raise NotImplementedError

    def record_outcome(self, action: Action, success: bool) -> None:
        """Hook called by the engine after the action executed (or failed).

        Default no-op; the circuit breaker and spending limit use it to update
        their windows from *real* outcomes."""


class SpendingLimit(Policy):
    """Per-action cap plus a rolling-window total cap.

    * ``per_action_cspr``: a single action may never spend more than this.
    * ``window_total_cspr``: the sum of spends inside ``window_seconds`` may
      never exceed this.

    Spends are only *committed* to the rolling window via :meth:`record_outcome`
    with ``success=True`` — i.e. a blocked or failed action does not consume
    budget. :meth:`evaluate` checks the prospective spend against both caps
    using the already-committed history.
    """

    name = "spending_limit"

    def __init__(
        self,
        *,
        per_action_cspr: object,
        window_total_cspr: object,
        window_seconds: float = 3600.0,
        clock: Optional[Clock] = None,
    ) -> None:
        self.per_action = Decimal(str(per_action_cspr))
        self.window_total = Decimal(str(window_total_cspr))
        self.window_seconds = float(window_seconds)
        self._clock: Clock = clock or time.time
        # (timestamp, amount) of committed spends.
        self._spends: Deque[Tuple[float, Decimal]] = deque()

    def _prune(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._spends and self._spends[0][0] < cutoff:
            self._spends.popleft()

    def committed_in_window(self) -> Decimal:
        now = self._clock()
        self._prune(now)
        return sum((amt for _, amt in self._spends), Decimal(0))

    def evaluate(self, action: Action) -> Decision:
        if not action.is_spend:
            return Decision.allow_(self.name, "non-spend action")
        amount = action.amount_cspr
        if amount > self.per_action:
            return Decision.block(
                self.name,
                f"spend {amount} CSPR exceeds per-action cap {self.per_action} CSPR",
            )
        committed = self.committed_in_window()
        if committed + amount > self.window_total:
            return Decision.block(
                self.name,
                f"spend {amount} CSPR would push rolling-window total to "
                f"{committed + amount} CSPR, over the {self.window_total} CSPR "
                f"cap (window={int(self.window_seconds)}s, already {committed} CSPR)",
            )
        return Decision.allow_(
            self.name,
            f"within caps (action {amount} CSPR, window {committed + amount}/"
            f"{self.window_total} CSPR)",
        )

    def record_outcome(self, action: Action, success: bool) -> None:
        if success and action.is_spend:
            self._spends.append((self._clock(), action.amount_cspr))


class ToolPermissions(Policy):
    """Allowlist of tool names the agent is permitted to call.

    A proposer that asks for a tool outside the allowlist is blocked outright —
    the canonical prompt-injection defense (the injected instruction may say
    "drain the credit line" but if ``draw_credit`` is not on the allowlist, the
    policy engine refuses)."""

    name = "tool_permissions"

    def __init__(self, allowed_tools: List[str]) -> None:
        self._allowed = frozenset(allowed_tools)

    @property
    def allowed(self) -> frozenset:
        return self._allowed

    def evaluate(self, action: Action) -> Decision:
        if action.tool in self._allowed:
            return Decision.allow_(self.name, f"tool '{action.tool}' on allowlist")
        return Decision.block(
            self.name,
            f"tool '{action.tool}' is NOT on the allowlist "
            f"{sorted(self._allowed)}",
        )


class CircuitBreaker(Policy):
    """Trips after ``threshold`` failures within ``window_seconds`` and blocks
    all calls until ``cooldown_seconds`` have elapsed since it tripped.

    Failures are fed in through :meth:`record_outcome` from *real* tool
    outcomes, so a flaky/abusive live dependency stops the agent rather than
    letting it hammer the API. A successful outcome while closed clears the
    failure history."""

    name = "circuit_breaker"

    class State(str, Enum):
        CLOSED = "closed"
        OPEN = "open"

    def __init__(
        self,
        *,
        threshold: int = 3,
        window_seconds: float = 60.0,
        cooldown_seconds: float = 120.0,
        clock: Optional[Clock] = None,
    ) -> None:
        if threshold < 1:
            raise ValueError("threshold must be >= 1")
        self.threshold = int(threshold)
        self.window_seconds = float(window_seconds)
        self.cooldown_seconds = float(cooldown_seconds)
        self._clock: Clock = clock or time.time
        self._failures: Deque[float] = deque()
        self._opened_at: Optional[float] = None

    @property
    def state(self) -> "CircuitBreaker.State":
        if self._opened_at is None:
            return CircuitBreaker.State.CLOSED
        if self._clock() - self._opened_at >= self.cooldown_seconds:
            # Cooldown elapsed -> half-close (we treat it as closed and let the
            # next outcome re-trip if it fails again).
            self._opened_at = None
            self._failures.clear()
            return CircuitBreaker.State.CLOSED
        return CircuitBreaker.State.OPEN

    def evaluate(self, action: Action) -> Decision:
        if self.state is CircuitBreaker.State.OPEN:
            remaining = self.cooldown_seconds - (self._clock() - (self._opened_at or 0))
            return Decision.block(
                self.name,
                f"circuit OPEN after {self.threshold}+ failures; cooling down "
                f"({remaining:.0f}s remaining)",
            )
        return Decision.allow_(self.name, "circuit closed")

    def record_outcome(self, action: Action, success: bool) -> None:
        now = self._clock()
        if success:
            # A real success resets the breaker.
            self._failures.clear()
            self._opened_at = None
            return
        cutoff = now - self.window_seconds
        while self._failures and self._failures[0] < cutoff:
            self._failures.popleft()
        self._failures.append(now)
        if len(self._failures) >= self.threshold and self._opened_at is None:
            self._opened_at = now


class ApprovalGate(Policy):
    """Actions whose spend is at or above ``threshold_cspr`` require explicit
    approval. An unapproved high-value action returns ``PENDING`` (held, not
    executed); the same action with ``approved=True`` passes."""

    name = "approval_gate"

    def __init__(self, *, threshold_cspr: object) -> None:
        self.threshold = Decimal(str(threshold_cspr))

    def evaluate(self, action: Action) -> Decision:
        if action.amount_cspr < self.threshold:
            return Decision.allow_(
                self.name, f"spend {action.amount_cspr} CSPR below approval threshold"
            )
        if action.approved:
            return Decision.allow_(
                self.name,
                f"spend {action.amount_cspr} CSPR approved (>= {self.threshold} CSPR)",
            )
        return Decision.pending_(
            self.name,
            f"spend {action.amount_cspr} CSPR >= {self.threshold} CSPR threshold; "
            f"explicit approval required",
        )


# --------------------------------------------------------------------------- #
# Composed engine
# --------------------------------------------------------------------------- #


class PolicyEngine:
    """Composes a list of policies. ``evaluate`` runs them in order and returns
    a :class:`PolicyResult` carrying every decision. The action is allowed only
    if ALL policies allow.

    The engine is the single chokepoint the :class:`~orchestrator.tools.ToolRouter`
    calls before any live API interaction, and the single place outcomes are
    reported back to stateful policies via :meth:`report_outcome`."""

    def __init__(self, policies: List[Policy]) -> None:
        if not policies:
            raise ValueError("PolicyEngine requires at least one policy")
        self._policies = list(policies)

    @property
    def policies(self) -> Tuple[Policy, ...]:
        return tuple(self._policies)

    def get(self, name: str) -> Optional[Policy]:
        for p in self._policies:
            if p.name == name:
                return p
        return None

    def policies_tools(self) -> frozenset:
        """The union of tool names permitted by any ToolPermissions policy
        (empty frozenset if no allowlist policy is present)."""
        tools: set = set()
        for p in self._policies:
            if isinstance(p, ToolPermissions):
                tools |= set(p.allowed)
        return frozenset(tools)

    def evaluate(self, action: Action) -> PolicyResult:
        decisions = tuple(p.evaluate(action) for p in self._policies)
        return PolicyResult(action=action, decisions=decisions)

    def report_outcome(self, action: Action, success: bool) -> None:
        """Feed a real execution outcome back to every stateful policy so
        spending windows and circuit breakers update from reality."""
        for p in self._policies:
            p.record_outcome(action, success)

    def describe(self) -> Dict[str, object]:
        out: Dict[str, object] = {}
        for p in self._policies:
            if isinstance(p, SpendingLimit):
                out[p.name] = {
                    "per_action_cspr": str(p.per_action),
                    "window_total_cspr": str(p.window_total),
                    "window_seconds": p.window_seconds,
                    "committed_in_window_cspr": str(p.committed_in_window()),
                }
            elif isinstance(p, ToolPermissions):
                out[p.name] = {"allowed_tools": sorted(p.allowed)}
            elif isinstance(p, CircuitBreaker):
                out[p.name] = {
                    "threshold": p.threshold,
                    "state": p.state.value,
                    "window_seconds": p.window_seconds,
                    "cooldown_seconds": p.cooldown_seconds,
                }
            elif isinstance(p, ApprovalGate):
                out[p.name] = {"threshold_cspr": str(p.threshold)}
            else:
                out[p.name] = {}
        return out
