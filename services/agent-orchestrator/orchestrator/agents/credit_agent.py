"""CreditAgent — obtains, draws and repays working capital.

A revenue-generating agent (default: ``EvidenceSellerAgent``, which the demo
seeds with x402 revenue and stake) that wants working capital. Its goals map to
the planner's credit/earn/repay flows. Its policy allowlist permits the credit
tools and evidence buying, but its spending limits are what stop a runaway draw.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from ..agent import Agent
from ..audit import AuditLog
from ..policy import (
    ApprovalGate,
    CircuitBreaker,
    PolicyEngine,
    SpendingLimit,
    ToolPermissions,
)

CREDIT_AGENT_TOOLS = [
    "get_passport",
    "explain_credit",
    "open_credit_line",
    "draw_credit",
    "repay_credit",
    "buy_evidence",
]


class CreditAgent(Agent):
    service_type = "credit"

    def __init__(
        self,
        *,
        client: Any,
        audit: AuditLog,
        agent_id: str = "EvidenceSellerAgent",
        signing_seed: Optional[bytes | str] = None,
        per_action_cspr: object = "3",
        window_total_cspr: object = "10",
        approval_threshold_cspr: object = "25",
        budget_cspr: object = "10",
    ) -> None:
        engine = PolicyEngine(
            [
                ToolPermissions(CREDIT_AGENT_TOOLS),
                SpendingLimit(
                    per_action_cspr=per_action_cspr,
                    window_total_cspr=window_total_cspr,
                    window_seconds=3600,
                ),
                ApprovalGate(threshold_cspr=approval_threshold_cspr),
                CircuitBreaker(threshold=3, window_seconds=60, cooldown_seconds=120),
            ]
        )
        super().__init__(
            agent_id=agent_id,
            client=client,
            engine=engine,
            audit=audit,
            signing_seed=signing_seed or f"cred402-credit-agent::{agent_id}",
            budget_cspr=budget_cspr,
        )

    def default_goal(self) -> str:
        return "borrow"
