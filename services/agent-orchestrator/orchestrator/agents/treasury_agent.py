"""TreasuryAgent — monitors treasury health and attests operators.

The treasury agent is conservative: it monitors reputation/underwriting signals
and produces RealFi operator attestations, but it is NOT permitted to draw or
buy. Its ToolPermissions allowlist deliberately EXCLUDES ``draw_credit`` and
``buy_evidence`` — so if a prompt injection ever tried to make the treasury bot
spend, the policy engine blocks it on the allowlist alone.
"""

from __future__ import annotations

from typing import Any, Optional

from ..agent import Agent
from ..audit import AuditLog
from ..policy import (
    CircuitBreaker,
    PolicyEngine,
    SpendingLimit,
    ToolPermissions,
)

TREASURY_AGENT_TOOLS = [
    "register_agent",
    "get_passport",
    "explain_credit",
    "verify_operator",
    # NOTE: no draw_credit / buy_evidence — treasury cannot spend.
]


class TreasuryAgent(Agent):
    service_type = "treasury"
    register_service_type = "treasury_routing"

    def __init__(
        self,
        *,
        client: Any,
        audit: AuditLog,
        agent_id: str = "TreasuryAgent",
        signing_seed: Optional[bytes | str] = None,
        # A tiny window cap so any accidental spend is caught twice (allowlist
        # AND budget). Treasury is monitor-only by design.
        per_action_cspr: object = "0",
        window_total_cspr: object = "0",
        budget_cspr: object = "0",
    ) -> None:
        engine = PolicyEngine(
            [
                ToolPermissions(TREASURY_AGENT_TOOLS),
                SpendingLimit(
                    per_action_cspr=per_action_cspr,
                    window_total_cspr=window_total_cspr,
                    window_seconds=3600,
                ),
                CircuitBreaker(threshold=3, window_seconds=60, cooldown_seconds=120),
            ]
        )
        super().__init__(
            agent_id=agent_id,
            client=client,
            engine=engine,
            audit=audit,
            signing_seed=signing_seed or f"cred402-treasury-agent::{agent_id}",
            budget_cspr=budget_cspr,
        )

    def default_goal(self) -> str:
        return "fund"
