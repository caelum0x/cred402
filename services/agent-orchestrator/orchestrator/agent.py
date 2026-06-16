"""The Agent — identity + budget + PolicyEngine + ToolRouter + Planner.

``run(goal)`` is the real autonomous loop:

1. Gather a live state snapshot (passport + credit explain) so the planner
   branches on reality.
2. Ask the planner for an ordered plan (the *proposal*).
3. Execute each step THROUGH the ToolRouter, which gates it on the policy
   engine (the *disposal*) and audits proposal + decision + outcome.
4. Stop on a blocked/pending step or an execution failure of a *critical* step;
   continue past non-critical read failures.

The agent never bypasses the engine: even the up-front state snapshot is taken
through routed, audited tool calls.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional

from .audit import AuditLog
from .planner import Plan, Planner, PlanStep
from .policy import PolicyEngine
from .tools import ToolResult, ToolRouter

# Tools whose failure or blockage should halt the run (spends / state-changers).
CRITICAL_TOOLS = frozenset({"draw_credit", "repay_credit", "open_credit_line", "buy_evidence"})


@dataclass
class StepRecord:
    """What happened for one executed plan step (for the run report)."""

    step: int
    plan: PlanStep
    result: ToolResult

    @property
    def verdict(self) -> str:
        return self.result.policy.deciding.verdict.value

    @property
    def line(self) -> str:
        r = self.result
        status = (
            "EXECUTED ok" if r.executed and r.success
            else "EXECUTION FAILED" if r.executed
            else f"NOT EXECUTED ({self.verdict})"
        )
        detail = r.error if r.error else _short(r.data)
        return f"[{self.verdict:7}] {self.plan.tool:16} {status} :: {detail}"


@dataclass
class RunReport:
    agent_id: str
    goal: str
    plan: Plan
    steps: List[StepRecord] = field(default_factory=list)
    stopped_reason: Optional[str] = None

    @property
    def blocked_steps(self) -> List[StepRecord]:
        return [s for s in self.steps if s.result.policy.blocked or s.result.policy.pending]

    @property
    def completed(self) -> bool:
        return self.stopped_reason is None


class Agent:
    """An autonomous Cred402 agent.

    Subclasses set :attr:`service_type` and may override :meth:`default_goal`.
    Identity, budget and safety all live in injected collaborators so the agent
    body stays a thin orchestration loop."""

    service_type = "generic"

    # Protocol-valid service_type used when self-registering (the API enforces an
    # enum). Subclasses override.
    register_service_type = "monitoring"

    def __init__(
        self,
        *,
        agent_id: str,
        client: Any,
        engine: PolicyEngine,
        audit: AuditLog,
        signing_seed: bytes | str,
        budget_cspr: object = 0,
        planner: Optional[Planner] = None,
    ) -> None:
        self.agent_id = agent_id
        self.budget_cspr = Decimal(str(budget_cspr))
        self._client = client
        self.engine = engine
        self.audit = audit
        self.planner = planner or Planner()
        self._signing_seed = signing_seed

    # -- state snapshot ----------------------------------------------------- #

    def _snapshot(self, router: ToolRouter) -> Dict[str, Any]:
        """Gather live facts for the planner via routed/audited reads."""
        state: Dict[str, Any] = {"agent_id": self.agent_id}
        passport = router.get_passport()
        if not passport.success and "register_agent" in self.engine.policies_tools():
            # Agent not yet on the protocol — self-register (a real API call),
            # then re-read its passport so the planner sees live state.
            router.register_agent(service_type=self.register_service_type)
            passport = router.get_passport()
        if passport.success:
            state["reputation_score"] = passport.data.get("reputation_score", 0)
            state["credit_score"] = passport.data.get("credit_score", 0)
            state["outstanding_debt_cspr"] = passport.data.get("outstanding_debt_cspr", "0")
        explain = router.explain_credit()
        if explain.success:
            state["eligible"] = explain.data.get("eligible", False)
            state["credit_line_cspr"] = explain.data.get("credit_line_cspr", "0")
            state["available_cspr"] = explain.data.get("credit_line_cspr", "0")
        return state

    def default_goal(self) -> str:
        return "borrow"

    # -- the loop ----------------------------------------------------------- #

    def run(self, goal: Optional[str] = None) -> RunReport:
        goal = goal or self.default_goal()
        router = ToolRouter(
            client=self._client,
            engine=self.engine,
            audit=self.audit,
            agent_id=self.agent_id,
            signing_seed=self._signing_seed,
            goal=goal,
        )

        state = self._snapshot(router)
        plan = self.planner.plan(goal, state)
        report = RunReport(agent_id=self.agent_id, goal=goal, plan=plan)

        for i, step in enumerate(plan.steps, start=1):
            result = self._run_step(router, step)
            report.steps.append(StepRecord(step=i, plan=step, result=result))

            if result.policy.blocked or result.policy.pending:
                verdict = result.policy.deciding.verdict.value
                report.stopped_reason = (
                    f"step {i} ({step.tool}) {verdict}: {result.policy.deciding.reason}"
                )
                break
            if result.executed and not result.success and step.tool in CRITICAL_TOOLS:
                report.stopped_reason = (
                    f"step {i} ({step.tool}) failed against live API: {result.error}"
                )
                break

        return report

    def _run_step(self, router: ToolRouter, step: PlanStep) -> ToolResult:
        tool = step.tool
        kwargs = dict(step.kwargs)
        if tool == "get_passport":
            return router.get_passport()
        if tool == "explain_credit":
            return router.explain_credit()
        if tool == "open_credit_line":
            return router.open_credit_line(**kwargs)
        if tool == "draw_credit":
            return router.draw_credit(**kwargs)
        if tool == "repay_credit":
            return router.repay_credit(**kwargs)
        if tool == "buy_evidence":
            return router.buy_evidence(**kwargs)
        if tool == "verify_operator":
            return router.verify_operator(**kwargs)
        raise ValueError(f"planner proposed unknown tool: {tool!r}")


def _short(data: Mapping[str, Any]) -> str:
    if not data:
        return "—"
    items = list(data.items())[:4]
    return ", ".join(f"{k}={v}" for k, v in items)
