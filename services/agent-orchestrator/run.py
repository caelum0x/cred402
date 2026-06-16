#!/usr/bin/env python3
"""CLI: run a Cred402 agent against the LIVE API under a real policy engine.

Usage::

    python3 run.py <agent> <goal> [--base-url URL] [--no-seed]

    agents: credit | treasury
    goals : credit  -> borrow | earn | repay
            treasury-> fund

Examples::

    python3 run.py credit borrow      # plan -> policy decisions -> draw (one BLOCKED)
    python3 run.py credit earn        # real x402 402->200 evidence purchase
    python3 run.py treasury fund      # monitor + operator attestation

It seeds the demo (POST /api/demo/run) unless ``--no-seed``, constructs the
agent with sane policy limits, runs the goal, and prints the plan, every policy
decision (including BLOCKED ones proving enforcement), the live tool outcomes,
and a final audit summary read back from the JSONL log.

Imports the local cred402 SDK by adding ./sdk/python to sys.path — the SDK is
not modified.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

# --- make the local cred402 SDK and this package importable (no pip install) --
_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent.parent  # services/agent-orchestrator -> services -> repo root
for _p in (str(_HERE), str(_REPO / "sdk" / "python")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from cred402 import Client  # noqa: E402
from cred402.errors import Cred402Error  # noqa: E402

from orchestrator.agent import Agent, RunReport  # noqa: E402
from orchestrator.agents.credit_agent import CreditAgent  # noqa: E402
from orchestrator.agents.treasury_agent import TreasuryAgent  # noqa: E402
from orchestrator.audit import AuditLog  # noqa: E402

DEFAULT_BASE_URL = os.environ.get("CRED402_BASE_URL", "http://localhost:4021")
AUDIT_PATH = _HERE / "audit_log.jsonl"

_BAR = "=" * 78
_RULE = "-" * 78


def _build_agent(name: str, client: Client, audit: AuditLog) -> Agent:
    if name == "credit":
        # per-action cap 3 CSPR is intentionally below the planner's 5 CSPR draw,
        # so the engine BLOCKS the over-cap draw — proving real enforcement.
        return CreditAgent(client=client, audit=audit)
    if name == "treasury":
        return TreasuryAgent(client=client, audit=audit)
    raise SystemExit(f"unknown agent {name!r}; choose 'credit' or 'treasury'")


def _print_policy_config(agent: Agent) -> None:
    print(f"\n{_BAR}\nPOLICY ENGINE (outside the proposer — the LLM proposes, this disposes)\n{_BAR}")
    for name, cfg in agent.engine.describe().items():
        print(f"  {name:18} {cfg}")


def _print_plan(report: RunReport) -> None:
    print(f"\n{_BAR}\nPLAN for goal {report.goal!r} (proposed by the rule-based planner)\n{_BAR}")
    for i, step in enumerate(report.plan.steps, start=1):
        print(f"  {i}. {step.describe()}")


def _print_execution(report: RunReport) -> None:
    print(f"\n{_BAR}\nEXECUTION (each step gated by the policy engine)\n{_BAR}")
    for rec in report.steps:
        print(f"  {rec.step}. {rec.line}")
        for d in rec.result.policy.decisions:
            mark = {"ALLOW": "+", "BLOCK": "x", "PENDING": "?"}.get(d.verdict.value, "-")
            print(f"       [{mark}] {d.policy:18} {d.verdict.value:7} {d.reason}")
    print(_RULE)
    if report.completed:
        print("  RUN COMPLETE: all planned steps passed policy and executed.")
    else:
        print(f"  RUN STOPPED: {report.stopped_reason}")
    blocked = report.blocked_steps
    if blocked:
        print(f"  POLICY-ENFORCED HALTS: {len(blocked)}")
        for b in blocked:
            print(f"    - step {b.step} {b.plan.tool}: {b.result.policy.summary}")


def _print_audit_summary(audit: AuditLog, agent_id: str) -> None:
    print(f"\n{_BAR}\nAUDIT SUMMARY (append-only JSONL, read back from disk)\n{_BAR}")
    summary = audit.summary()
    print(f"  log: {summary['path']}")
    print(f"  total entries: {summary['total_entries']}  "
          f"executed: {summary['executed']}  "
          f"execution failures: {summary['execution_failures']}")
    print(f"  by verdict: {summary['by_verdict']}")
    blocked = list(audit.query(agent_id=agent_id, verdict="BLOCK"))
    if blocked:
        print(f"\n  BLOCKED actions for {agent_id} (proof the engine enforced limits):")
        for rec in blocked:
            print(f"    seq {rec['seq']:>3}  step {rec['step']}  {rec['tool']:16} "
                  f"{rec['amount_cspr']} CSPR  ->  {rec['deciding_policy']}: {rec['reason']}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a Cred402 agent under a real policy engine.")
    parser.add_argument("agent", choices=["credit", "treasury"])
    parser.add_argument("goal", nargs="?", default=None,
                        help="credit: borrow|earn|repay  treasury: fund")
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--no-seed", action="store_true", help="skip POST /api/demo/run")
    parser.add_argument("--audit-path", default=str(AUDIT_PATH))
    args = parser.parse_args(argv)

    client = Client(args.base_url)

    # Health check so we fail loudly if the live API is not up.
    try:
        health = client.health()
    except Cred402Error as exc:
        print(f"ERROR: cannot reach Cred402 API at {args.base_url}: {exc}", file=sys.stderr)
        return 2
    print(f"{_BAR}\nCred402 agent orchestrator — LIVE run\n{_BAR}")
    print(f"  api: {args.base_url}  health: {health}")

    if not args.no_seed:
        try:
            client.run_demo()
            print("  seeded demo ledger via POST /api/demo/run")
        except Cred402Error as exc:
            print(f"  WARN: demo seed failed ({exc}); continuing with existing state")
        time.sleep(0.3)

    # Fresh audit log per run so the summary is self-contained.
    audit_path = Path(args.audit_path)
    if audit_path.exists():
        audit_path.unlink()
    audit = AuditLog(audit_path)

    agent = _build_agent(args.agent, client, audit)
    goal = args.goal or agent.default_goal()

    _print_policy_config(agent)
    report = agent.run(goal)
    _print_plan(report)
    _print_execution(report)
    _print_audit_summary(audit, agent.agent_id)
    print(f"\n{_BAR}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
