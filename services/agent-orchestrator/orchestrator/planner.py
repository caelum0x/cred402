"""A deterministic, rule-based planner — the slot an LLM would occupy.

The planner is the *proposer* in "the LLM proposes, the policy engine disposes".
Here it is deliberately NOT an LLM: it is auditable, deterministic branching
over live protocol state, so the demo is reproducible. Swapping in an LLM later
changes only this file — the policy engine downstream is unchanged and still
disposes of whatever is proposed.

A plan is an ordered list of :class:`PlanStep`. Each step names a tool plus its
kwargs and an estimated spend. The agent executes steps in order, each gated by
the policy engine.

Goals understood:

* ``borrow`` / ``working_capital`` — obtain and draw working capital:
  explain credit -> (open line if eligible) -> draw a tranche.
* ``earn`` / ``buy_evidence``      — spend on x402 evidence to build revenue.
* ``repay``                        — repay outstanding credit.
* ``fund`` / ``treasury``          — treasury monitoring + an operator attest.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Dict, List, Mapping, Optional


@dataclass(frozen=True)
class PlanStep:
    """One proposed step: a tool name, its kwargs, and an estimated spend."""

    tool: str
    kwargs: Mapping[str, Any] = field(default_factory=dict)
    estimated_cspr: Decimal = Decimal(0)
    rationale: str = ""

    def describe(self) -> str:
        spend = f" (~{self.estimated_cspr} CSPR)" if self.estimated_cspr else ""
        return f"{self.tool}{spend} — {self.rationale}"


@dataclass(frozen=True)
class Plan:
    goal: str
    steps: List[PlanStep]

    def __len__(self) -> int:
        return len(self.steps)


class Planner:
    """Builds a :class:`Plan` from a goal and a snapshot of live agent state.

    ``state`` is a dict of facts the agent gathered up front (eligibility,
    reputation, available credit). Branching is real: an ineligible agent gets
    no draw step; a low-reputation agent gets an evidence-buying step first."""

    # Branching thresholds (config, not magic numbers scattered in logic).
    MIN_REPUTATION = 60
    DEFAULT_DRAW_CSPR = Decimal("5")
    DEFAULT_REPAY_CSPR = Decimal("2")

    def plan(self, goal: str, state: Mapping[str, Any]) -> Plan:
        g = goal.strip().lower()
        if g in ("borrow", "working_capital", "credit", "obtain working capital"):
            return Plan(goal, self._plan_working_capital(state))
        if g in ("earn", "buy", "buy_evidence", "evidence"):
            return Plan(goal, self._plan_earn(state))
        if g in ("repay", "settle"):
            return Plan(goal, self._plan_repay(state))
        if g in ("fund", "treasury", "deposit", "monitor"):
            return Plan(goal, self._plan_treasury(state))
        # Unknown goal -> a safe read-only inspection plan.
        return Plan(goal, [PlanStep("get_passport", rationale="unknown goal; inspect state only")])

    # -- goal builders ------------------------------------------------------ #

    def _plan_working_capital(self, state: Mapping[str, Any]) -> List[PlanStep]:
        steps: List[PlanStep] = [
            PlanStep("get_passport", rationale="check identity, reputation and existing debt"),
            PlanStep("explain_credit", rationale="check eligibility + credit line before borrowing"),
        ]
        reputation = int(state.get("reputation_score", 0))
        if reputation < self.MIN_REPUTATION:
            # Too thin to underwrite well -> earn first (build x402 revenue).
            steps.append(
                PlanStep(
                    "buy_evidence",
                    kwargs={"evidence_type": "energy_output", "rwa_id": "SOLAR-A17"},
                    estimated_cspr=Decimal("0.002"),
                    rationale=f"reputation {reputation} < {self.MIN_REPUTATION}: build x402 revenue first",
                )
            )

        if not state.get("eligible", False):
            steps.append(
                PlanStep(
                    "get_passport",
                    rationale="not yet eligible for a line; re-inspect and stop short of drawing",
                )
            )
            return steps

        steps.append(PlanStep("open_credit_line", rationale="eligible: underwrite and open a line"))

        # Draw a tranche, but never propose more than the available headroom.
        available = Decimal(str(state.get("available_cspr", self.DEFAULT_DRAW_CSPR)))
        draw = min(self.DEFAULT_DRAW_CSPR, available) if available > 0 else self.DEFAULT_DRAW_CSPR
        steps.append(
            PlanStep(
                "draw_credit",
                kwargs={"amount_cspr": float(draw)},
                estimated_cspr=draw,
                rationale=f"draw {draw} CSPR working capital",
            )
        )
        return steps

    def _plan_earn(self, state: Mapping[str, Any]) -> List[PlanStep]:
        return [
            PlanStep("get_passport", rationale="baseline revenue + receipts"),
            PlanStep(
                "buy_evidence",
                kwargs={"evidence_type": "energy_output", "rwa_id": "SOLAR-A17"},
                estimated_cspr=Decimal("0.002"),
                rationale="pay for x402 solar evidence (records a real receipt)",
            ),
            PlanStep("get_passport", rationale="confirm receipt/revenue moved"),
        ]

    def _plan_repay(self, state: Mapping[str, Any]) -> List[PlanStep]:
        amount = Decimal(str(state.get("repay_cspr", self.DEFAULT_REPAY_CSPR)))
        return [
            PlanStep("get_passport", rationale="read outstanding debt"),
            PlanStep("open_credit_line", rationale="ensure a live line handle to repay against"),
            PlanStep(
                "repay_credit",
                kwargs={"amount_cspr": float(amount)},
                rationale=f"repay {amount} CSPR of outstanding credit",
            ),
        ]

    def _plan_treasury(self, state: Mapping[str, Any]) -> List[PlanStep]:
        return [
            PlanStep("get_passport", rationale="monitor treasury agent reputation + debt"),
            PlanStep("explain_credit", rationale="monitor underwriting signals / fraud score"),
            PlanStep(
                "verify_operator",
                kwargs={
                    "operator_id": state.get("operator_id", "OP-TREASURY-DEMO"),
                    "verification_reference": state.get("verification_reference", "REF-TREASURY-001"),
                },
                rationale="attest a verified operator (RealFi multiplier input)",
            ),
        ]
