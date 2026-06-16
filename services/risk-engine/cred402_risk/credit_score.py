"""Probability-of-default credit model for the Cred402 risk engine.

A hand-tuned logistic-regression underwriting model. It is deterministic and
explainable by design — p2 §7.6 mandates "deterministic scoring first,
ML second. The LLM explains, but does not directly control money."

Model
-----
For an agent with feature vector ``x``:

    z   = INTERCEPT + Σ_i  COEF_i * standardize(x_i)
    pd  = sigmoid(z)                       # probability of default, 0..1
    credit_score = round(100 * (1 - pd))   # 0..100, higher is safer
    interest_rate_bps = rate_from_score(credit_score)

Each feature is standardized to a z-score using fixed, documented
``(mean, std)`` reference statistics (``FEATURE_STATS``) so a single agent can
be scored in isolation without needing the rest of the population. The
standardized value is then clipped to ±4 σ to keep extreme inputs from
saturating the sigmoid.

The signed coefficients encode credit intuition:
  * positive coefficient  -> the feature *raises* default probability (risk up)
  * negative coefficient  -> the feature *lowers* default probability (risk down)

``reason_contributions`` performs a real linear (SHAP-for-linear-models)
attribution: contribution_i = COEF_i * standardize(x_i). For a logit-linear
model these contributions sum exactly to ``z - INTERCEPT``, so the ranking is a
faithful decomposition of the score, not a heuristic.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from .features import AgentFeatures

# ---------------------------------------------------------------------------
# Reference standardization statistics: (mean, std) per feature.
# These describe a "typical" healthy autonomous RWA agent on Cred402 and are
# used to turn raw features into z-scores. Hand-tuned from the protocol's
# expected operating ranges (motes/CSPR economics, 0..100 quality scores).
# ---------------------------------------------------------------------------
FEATURE_STATS: dict[str, tuple[float, float]] = {
    # 30-day revenue in CSPR. Healthy agents clear a few CSPR/month.
    "revenue_velocity_30d_cspr": (3.0, 3.0),
    # OLS revenue trend (CSPR/day). Centered at 0 (flat); positive = growing.
    "revenue_trend_slope": (0.0, 0.05),
    # Counterparty Herfindahl (0..1). 0.45 ~ moderately diversified book.
    "counterparty_concentration_hhi": (0.45, 0.25),
    # Coefficient of variation of receipt inter-arrivals. Organic ~0.8.
    "cadence_cv": (0.8, 0.5),
    # Dispute-adjusted accuracy (0..100). Good agents sit high.
    "dispute_adjusted_accuracy": (80.0, 12.0),
    # Raw dispute rate (0..1). Most agents near 0; std small.
    "dispute_rate": (0.04, 0.06),
    # Stake coverage ratio (months of revenue covered by stake).
    "stake_coverage_ratio": (8.0, 8.0),
    # Account age in days.
    "account_age_days": (90.0, 75.0),
    # Reputation score (0..100).
    "reputation_score": (70.0, 15.0),
}

# ---------------------------------------------------------------------------
# Logistic-regression coefficients (log-odds of DEFAULT per +1 σ of feature).
# Sign convention: positive => increases probability of default.
# ---------------------------------------------------------------------------
INTERCEPT: float = -1.20  # base log-odds; pd(sigmoid(-1.2)) ~ 0.23 at the mean agent

COEFFICIENTS: dict[str, float] = {
    # More recent revenue => more proven cash flow => LOWER default risk.
    "revenue_velocity_30d_cspr": -0.85,
    # Upward revenue trend => improving business => LOWER risk.
    "revenue_trend_slope": -0.40,
    # Concentrated counterparties => fragile / wash-trade-prone => HIGHER risk.
    "counterparty_concentration_hhi": 0.70,
    # Metronomic cadence (LOW cv) is suspicious; ORGANIC bursty (HIGH cv) is
    # healthier, so higher cv slightly LOWERS risk.
    "cadence_cv": -0.25,
    # Higher dispute-adjusted accuracy => reliable delivery => LOWER risk.
    "dispute_adjusted_accuracy": -0.95,
    # Higher raw dispute rate => more contested work => HIGHER risk.
    "dispute_rate": 0.90,
    # More stake coverage => more skin in the game => LOWER risk.
    "stake_coverage_ratio": -0.60,
    # Older account => more track record => LOWER risk.
    "account_age_days": -0.45,
    # Higher reputation => LOWER risk.
    "reputation_score": -0.70,
}

# Clip standardized features to this many sigmas to avoid sigmoid saturation.
SIGMA_CLIP: float = 4.0

# Human-readable reason codes (p2 §7.6 example reason codes).
REASON_CODES: dict[str, tuple[str, str]] = {
    # feature -> (code when it LOWERS risk, code when it RAISES risk)
    "revenue_velocity_30d_cspr": ("STRONG_RECENT_REVENUE", "WEAK_RECENT_REVENUE"),
    "revenue_trend_slope": ("IMPROVING_REVENUE_TREND", "DECLINING_REVENUE_TREND"),
    "counterparty_concentration_hhi": ("DIVERSIFIED_COUNTERPARTIES", "HIGH_SERVICE_CONCENTRATION"),
    "cadence_cv": ("ORGANIC_RECEIPT_CADENCE", "SUSPICIOUS_RECEIPT_CYCLE"),
    "dispute_adjusted_accuracy": ("HIGH_VERIFIED_ACCURACY", "LOW_VERIFIED_ACCURACY"),
    "dispute_rate": ("LOW_DISPUTE_RATE", "ELEVATED_DISPUTE_RATE"),
    "stake_coverage_ratio": ("STRONG_STAKE_COVERAGE", "WEAK_STAKE_COVERAGE"),
    "account_age_days": ("ESTABLISHED_AGENT", "YOUNG_AGENT"),
    "reputation_score": ("STRONG_REPUTATION", "WEAK_REPUTATION"),
}


def sigmoid(z: float) -> float:
    """Numerically stable logistic sigmoid."""
    if z >= 0:
        ez = math.exp(-z)
        return 1.0 / (1.0 + ez)
    ez = math.exp(z)
    return ez / (1.0 + ez)


def standardize(name: str, value: float) -> float:
    """z-score a feature against its reference (mean, std), clipped to ±SIGMA_CLIP."""
    mean, std = FEATURE_STATS[name]
    if std <= 0:
        return 0.0
    z = (value - mean) / std
    return max(-SIGMA_CLIP, min(SIGMA_CLIP, z))


def _feature_value(features: AgentFeatures, name: str) -> float:
    return float(getattr(features, name))


@dataclass(frozen=True)
class CreditAssessment:
    """Result of scoring one agent."""

    agent_id: str
    pd: float                       # probability of default, 0..1
    credit_score: int               # 0..100, higher is safer
    interest_rate_bps: int          # recommended annual rate, basis points
    risk_bucket: str                # PRIME / NEAR_PRIME / SUBPRIME / HIGH_RISK
    confidence_score: float         # 0..1, data-sufficiency heuristic
    z: float                        # raw logit
    reason_contributions: list[dict]  # ranked linear attributions

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "pd": round(self.pd, 6),
            "credit_score": self.credit_score,
            "interest_rate_bps": self.interest_rate_bps,
            "risk_bucket": self.risk_bucket,
            "confidence_score": round(self.confidence_score, 4),
            "logit": round(self.z, 6),
            "reason_contributions": self.reason_contributions,
        }


def logit(features: AgentFeatures) -> float:
    """Compute z = INTERCEPT + Σ COEF_i * standardize(x_i)."""
    z = INTERCEPT
    for name, coef in COEFFICIENTS.items():
        z += coef * standardize(name, _feature_value(features, name))
    return z


def probability_of_default(features: AgentFeatures) -> float:
    return sigmoid(logit(features))


def credit_score_from_pd(pd: float) -> int:
    """0..100 credit score; higher is safer."""
    return int(round(100 * (1.0 - pd)))


def interest_rate_bps_from_score(score: int) -> int:
    """Recommended annual interest rate in basis points from the credit score.

    Linear ramp between a prime floor and a high-risk ceiling. A score of 100
    earns the floor; a score of 0 earns the ceiling.

        rate = FLOOR + (CEIL - FLOOR) * (100 - score) / 100
    """
    floor_bps = 300    # 3.00% APR for a perfect agent
    ceil_bps = 3500    # 35.00% APR for the riskiest agent
    score = max(0, min(100, score))
    rate = floor_bps + (ceil_bps - floor_bps) * (100 - score) / 100.0
    return int(round(rate))


def risk_bucket_from_score(score: int) -> str:
    if score >= 80:
        return "PRIME"
    if score >= 65:
        return "NEAR_PRIME"
    if score >= 45:
        return "SUBPRIME"
    return "HIGH_RISK"


def confidence_score(features: AgentFeatures) -> float:
    """Data-sufficiency confidence in [0, 1].

    Thin files (few revenue events, brand-new accounts) get low confidence so
    downstream policy can widen its safety margins. This does not change ``pd``;
    it qualifies how much to trust it.
    """
    n_events = features.revenue_event_count
    age = features.account_age_days
    event_term = min(1.0, n_events / 20.0)          # saturates at 20 events
    age_term = min(1.0, age / 60.0)                 # saturates at 60 days
    has_counterparties = 1.0 if features.counterparty_count >= 2 else 0.5
    return round(0.5 * event_term + 0.3 * age_term + 0.2 * has_counterparties, 4)


def reason_contributions(features: AgentFeatures, top_k: int = 6) -> list[dict]:
    """Real linear (SHAP-for-linear) attribution of the logit.

    contribution_i = COEF_i * standardize(x_i). These sum to ``z - INTERCEPT``.
    Negative contribution => pushes toward *lower* default (good); positive =>
    pushes toward default (bad). Returns the top ``top_k`` by absolute impact,
    each tagged with a human reason code.
    """
    contribs: list[dict] = []
    for name, coef in COEFFICIENTS.items():
        raw = _feature_value(features, name)
        z = standardize(name, raw)
        contribution = coef * z
        good_code, bad_code = REASON_CODES[name]
        # contribution < 0 lowers default risk (good); > 0 raises it (bad).
        code = good_code if contribution < 0 else bad_code
        contribs.append(
            {
                "feature": name,
                "raw_value": round(raw, 6),
                "standardized": round(z, 4),
                "coefficient": coef,
                "contribution": round(contribution, 6),
                "direction": "lowers_risk" if contribution < 0 else "raises_risk",
                "reason_code": code,
            }
        )
    contribs.sort(key=lambda c: abs(c["contribution"]), reverse=True)
    return contribs[:top_k]


def assess(features: AgentFeatures, top_k: int = 6) -> CreditAssessment:
    """Full credit assessment for one agent."""
    z = logit(features)
    pd = sigmoid(z)
    score = credit_score_from_pd(pd)
    return CreditAssessment(
        agent_id=features.agent_id,
        pd=pd,
        credit_score=score,
        interest_rate_bps=interest_rate_bps_from_score(score),
        risk_bucket=risk_bucket_from_score(score),
        confidence_score=confidence_score(features),
        z=z,
        reason_contributions=reason_contributions(features, top_k=top_k),
    )
