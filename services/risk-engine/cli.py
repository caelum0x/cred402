#!/usr/bin/env python3
"""Command-line interface for the Cred402 risk + fraud engine.

Fetches live data from the Cred402 API and prints results as formatted JSON.

Usage::

    python3 cli.py score <agent_id>
    python3 cli.py fraud <agent_id>
    python3 cli.py portfolio

Environment:
    CRED402_API   base URL of the Cred402 API (default http://localhost:4021)
"""

from __future__ import annotations

import json
import os
import sys

# Make the package importable when run as `python3 cli.py` from anywhere.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from cred402_risk.client import Cred402APIError, Cred402Client  # noqa: E402
from cred402_risk.server import fraud_agent, portfolio, score_agent  # noqa: E402

USAGE = """\
cred402-risk — advisory risk + fraud scoring CLI

usage:
  python3 cli.py score <agent_id>      probability-of-default credit assessment
  python3 cli.py fraud <agent_id>      receipt-graph fraud assessment
  python3 cli.py portfolio             leaderboard of all agents

env:
  CRED402_API   Cred402 API base URL (default http://localhost:4021)
"""


def _emit(obj) -> None:
    print(json.dumps(obj, indent=2, sort_keys=False))


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        return 0 if argv else 1

    command = argv[0]
    client = Cred402Client()

    try:
        agents, receipts = client.fetch_all()
    except Cred402APIError as exc:
        print(f"error: {exc}", file=sys.stderr)
        print(f"  (is the Cred402 API running at {client.base_url}?)", file=sys.stderr)
        return 2

    if command == "portfolio":
        _emit(portfolio(agents, receipts))
        return 0

    if command in ("score", "fraud"):
        if len(argv) < 2:
            print(f"error: '{command}' requires an <agent_id>", file=sys.stderr)
            return 1
        agent_id = argv[1]
        if command == "score":
            result = score_agent(agent_id, agents, receipts)
        else:
            result = fraud_agent(agent_id, agents, receipts)
        if result is None:
            print(f"error: agent '{agent_id}' not found", file=sys.stderr)
            known = sorted(a.get("agent_id", "?") for a in agents)
            print(f"  known agents: {', '.join(known)}", file=sys.stderr)
            return 3
        _emit(result)
        return 0

    print(f"error: unknown command '{command}'\n", file=sys.stderr)
    print(USAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
