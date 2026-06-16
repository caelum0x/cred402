"""Cred402 — Python SDK for the Cred402 protocol.

Credit lines for autonomous RWA agents on Casper: x402 machine-to-machine
revenue becomes on-chain reputation and DeFi credit.

Quickstart::

    from cred402 import Client

    client = Client("http://localhost:4021")
    print(client.health())
    for agent in client.agents.list():
        print(agent.agent_id, agent.reputation_score)

This package depends only on the Python standard library (Python 3.10+).
"""

from __future__ import annotations

from .client import Cred402Client
from .errors import (
    Cred402ConfigError,
    Cred402Error,
    PaymentRequiredError,
)
from .models import (
    Agent,
    ApiKey,
    ComplianceCheck,
    ComplianceResult,
    CreditDecision,
    CreditExplain,
    CreditLine,
    CreditPool,
    Dispute,
    EconomicsView,
    MarketListing,
    Passport,
    ReasonCode,
    cspr_to_motes,
    motes_to_cspr,
)
from .x402 import (
    PaymentAuthorization,
    PaymentChallenge,
    PaymentProof,
    build_payment_proof,
    verify_proof,
)

# Friendly alias: `from cred402 import Client`.
Client = Cred402Client

__version__ = "0.1.0"

__all__ = [
    "Client",
    "Cred402Client",
    "Cred402Error",
    "Cred402ConfigError",
    "PaymentRequiredError",
    # models
    "Agent",
    "ApiKey",
    "ComplianceCheck",
    "ComplianceResult",
    "CreditDecision",
    "CreditExplain",
    "CreditLine",
    "CreditPool",
    "Dispute",
    "EconomicsView",
    "MarketListing",
    "Passport",
    "ReasonCode",
    "motes_to_cspr",
    "cspr_to_motes",
    # x402
    "PaymentChallenge",
    "PaymentAuthorization",
    "PaymentProof",
    "build_payment_proof",
    "verify_proof",
    "__version__",
]
