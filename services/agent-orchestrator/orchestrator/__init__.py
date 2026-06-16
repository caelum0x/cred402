"""Cred402 agent orchestrator — a production autonomous-agent runtime.

The central design principle (p4 Attack 4): *the LLM proposes, the
policy engine disposes*. A planner (here deterministic and rule-based, but the
slot an LLM would occupy) emits a plan of tool calls; every single call is then
forced through a real :class:`~orchestrator.policy.PolicyEngine` that sits
OUTSIDE the proposer. Spending limits, tool allowlists, circuit breakers and
approval gates are enforced regardless of what the proposer wants, and every
proposed action plus its policy decision plus its outcome is written to an
append-only audit log.

Public surface::

    from orchestrator.agent import Agent
    from orchestrator.policy import PolicyEngine, Action, Decision
    from orchestrator.tools import ToolRouter
    from orchestrator.audit import AuditLog
    from orchestrator.planner import Planner

Standard library only (plus the local ``cred402`` SDK). Python 3.10+.
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
