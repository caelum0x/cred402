"""Cred402 advisory risk + fraud engine.

A standard-library-only Python package that computes advisory risk scores and
fraud signals the protocol's ``RiskPolicyManager`` (p2 §6.8) can consume.

Pipeline
--------
1. :mod:`cred402_risk.client`       fetch live agents + receipts from the Cred402 API.
2. :mod:`cred402_risk.features`     pure feature engineering over agent + receipt dicts.
3. :mod:`cred402_risk.credit_score` logistic probability-of-default + credit score + rate.
4. :mod:`cred402_risk.fraud_graph`  receipt-graph fraud detection (Tarjan SCC, wash trading).
5. :mod:`cred402_risk.server`       http.server JSON API exposing the above.

Nothing here moves money. Scores are *advisory*; the on-chain
``RiskPolicyManager`` remains the deterministic authority (p2 §7.6:
"the LLM explains, but does not directly control money").
"""

from __future__ import annotations

from . import client, credit_score, features, fraud_graph

__all__ = ["client", "credit_score", "features", "fraud_graph"]
__version__ = "0.1.0"
