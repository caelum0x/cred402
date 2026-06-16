#!/usr/bin/env python3
"""WeatherRiskAgent — a real, runnable autonomous Cred402 agent.

This script drives the live Cred402 server end to end using only the SDK and the
Python standard library:

  1. Connects and checks server health.
  2. Registers itself (idempotently) as a `weather_risk` agent.
  3. Seeds the ledger by running the protocol demo (POST /api/demo/run), which
     produces an established agent with real x402 revenue + credit history.
  4. Fetches its own passport and the credit explanation (reason codes) for an
     established agent it can actually underwrite against.
  5. Opens a credit line, inspects the explainable reason codes, and — if the
     economics make sense — draws a small amount of working capital, then repays.
  6. Prints a decision narrative an operator (or another agent) can audit.

Run it::

    # start the server first:  npm start
    python3 sdk/python/examples/autonomous_agent.py
    # or against a remote host:
    CRED402_BASE_URL=http://localhost:4021 python3 sdk/python/examples/autonomous_agent.py

It exits non-zero if it cannot reach the server or a required step fails.
"""

from __future__ import annotations

import os
import sys
import time
from decimal import Decimal
from pathlib import Path

# Make the SDK importable when run straight from the repo (no install needed).
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cred402 import Client, Cred402Error  # noqa: E402
from cred402.models import CreditExplain, ReasonCode  # noqa: E402


BASE_URL = os.environ.get("CRED402_BASE_URL", "http://localhost:4021")
API_KEY = os.environ.get("CRED402_API_KEY")  # optional; dev server is open
SELF_ID = "WeatherRiskAgent"
SELF_SERVICE = "weather_risk"


def hr(title: str) -> None:
    print("\n" + "=" * 64)
    print(f"  {title}")
    print("=" * 64)


def fmt_cspr(amount: Decimal) -> str:
    return f"{amount.normalize():,f} CSPR"


def render_reasons(explain: CreditExplain) -> None:
    print(f"  credit score   : {explain.decision.credit_score}/100")
    print(f"  credit line    : {fmt_cspr(explain.decision.credit_line_cspr)}")
    print(f"  interest rate  : {explain.decision.interest_rate_pct:.2f}%")
    print(f"  fraud score    : {explain.fraud_score}")
    print(f"  realfi factor  : x{explain.realfi_multiplier:.2f}")
    print("  reason codes:")
    for rc in explain.reason_codes:
        mark = "+" if rc.is_positive else ("-" if rc.is_negative else "·")
        print(f"    [{mark}] {rc.code:<32} {rc.detail}")


def pick_established_agent(client: Client) -> str:
    """Find a seeded agent with real history to underwrite against.

    The demo loop creates `EvidenceSellerAgent` with finalized x402 receipts;
    prefer it, else fall back to the highest-reputation agent available.
    """
    agents = client.agents.list()
    for a in agents:
        if a.agent_id == "EvidenceSellerAgent":
            return a.agent_id
    ranked = sorted(agents, key=lambda a: a.reputation_score, reverse=True)
    return ranked[0].agent_id if ranked else SELF_ID


def main() -> int:
    client = Client(BASE_URL, api_key=API_KEY)

    hr("WeatherRiskAgent waking up")
    try:
        health = client.health()
    except Cred402Error as exc:
        print(f"FATAL: cannot reach Cred402 server at {BASE_URL}: {exc}", file=sys.stderr)
        print("       Start it with `npm start` and retry.", file=sys.stderr)
        return 1
    print(f"  server   : {BASE_URL}")
    print(f"  env      : {health.get('env')}")
    print(f"  policy   : {health.get('policy')}")

    # 1. Register self (idempotent: a repeat run just refreshes the passport).
    hr("Registering on-chain identity")
    idem = f"register-{SELF_ID}"
    try:
        passport = client.agents.register(
            SELF_ID, SELF_SERVICE, idempotency_key=idem
        )
        print(f"  registered {passport.agent_id} as `{passport.service_type}`")
    except Cred402Error as exc:
        # Already-registered is fine; fetch the existing passport.
        print(f"  registration note: {exc.message}; fetching existing passport")
        passport = client.agents.passport(SELF_ID)
    print(f"  reputation     : {passport.reputation_score}")
    print(f"  spending limit : {fmt_cspr(passport.outstanding_debt_cspr or Decimal(0))}")
    print(f"  risk flags     : {', '.join(passport.risk_flags) or 'none'}")

    # 2. Seed real protocol activity so there is something to underwrite.
    hr("Seeding protocol activity (POST /api/demo/run)")
    demo = client.run_demo()
    scenes = demo.get("scenes", [])
    print(f"  demo produced {len(scenes)} scene(s)")
    for scene in scenes[:5]:
        label = scene.get("title") or scene.get("name") or scene.get("step") or scene
        print(f"    • {label}")
    time.sleep(0.2)  # let the ledger settle

    # 3. Read the marketplace + pool to understand the environment.
    hr("Surveying the marketplace and lending pool")
    listings = client.marketplace.list()
    print(f"  {len(listings)} listing(s):")
    for m in listings[:5]:
        print(
            f"    {m.listing_id}  {m.agent_id:<20} {m.category:<22} "
            f"price={fmt_cspr(m.base_price_cspr)}  rep={m.reputation_score}"
        )
    pool = client.credit.pool()
    print(f"  pool liquidity : {fmt_cspr(pool.total_liquidity_cspr)}")
    print(f"  outstanding    : {fmt_cspr(pool.outstanding_credit_cspr)}")
    print(f"  utilization    : {pool.utilization * 100:.2f}%")

    econ = client.economics.get()
    print(f"  realized APY   : {econ.realized_apy * 100:.2f}%")
    if econ.risk_flags:
        print(f"  pool risk flags: {', '.join(econ.risk_flags)}")

    # 4. Choose an established agent to underwrite (one with real revenue).
    target = pick_established_agent(client)
    hr(f"Underwriting `{target}` — explainable credit decision")
    explain = client.credit.explain(target)
    render_reasons(explain)

    compliance = client.compliance.check(target)
    print(f"  compliance     : {'CLEARED' if compliance.cleared else 'BLOCKED'} ({compliance.subject})")

    # 5. Decision: open a line, then act on it if the score clears a threshold.
    hr("Decision narrative")
    score = explain.decision.credit_score
    negatives = [rc.code for rc in explain.decision.negative_reasons]
    print(f"  Target agent `{target}` scored {score}/100.")
    if negatives:
        print(f"  Risk flags observed: {', '.join(negatives)}.")

    if score < 40:
        print("  -> DECLINE: score below 40 risk threshold. No line opened.")
        return 0

    print("  -> APPROVE: opening a 30-day credit line.")
    decision, line = client.credit.open_line(
        target, term_days=30, idempotency_key=f"open-{target}"
    )
    print(f"     line opened: max={fmt_cspr(line.max_credit_cspr)} "
          f"drawn={fmt_cspr(line.drawn_cspr)} status={line.status}")
    print(f"     available  : {fmt_cspr(line.available_cspr)}")
    print(f"     health     : {line.health_factor:.2f}")

    # Draw a tiny, safe amount of working capital and immediately repay part of it.
    draw_amount = 1  # CSPR
    if line.available_cspr >= Decimal(draw_amount):
        after_draw = client.credit.draw(target, draw_amount, idempotency_key=f"draw-{target}-1")
        print(f"     drew {draw_amount} CSPR -> drawn now {fmt_cspr(after_draw.drawn_cspr)}")
        repay = client.credit.repay(target, draw_amount, idempotency_key=f"repay-{target}-1")
        repaid_line = repay["line"]
        print(f"     repaid {draw_amount} CSPR (+interest {repay['interest_motes']} motes) "
              f"-> drawn now {fmt_cspr(repaid_line.drawn_cspr)}")
    else:
        print("     available credit too small to draw safely; holding.")

    hr("WeatherRiskAgent run complete")
    print("  All actions executed against the live Cred402 server.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Cred402Error as exc:
        print(f"\nCred402Error: {exc}", file=sys.stderr)
        raise SystemExit(2)
