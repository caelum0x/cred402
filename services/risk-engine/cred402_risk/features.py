"""Feature engineering for the Cred402 risk engine.

Pure functions over plain ``dict`` records as returned by the Cred402 API
(``GET /api/agents`` and ``GET /api/receipts``). Nothing here mutates its
inputs; every function returns new values.

Money fields (``stake``, ``amount``) arrive as *motes* — either decimal strings
or numbers — because the upstream API serializes ``bigint`` as a string. We
normalize everything through :func:`to_motes`. 1 CSPR = 1_000_000_000 motes.

Timestamps are Unix epoch *seconds*. The Cred402 demo seeds data with
timestamps that can sit in the future relative to wall-clock, so every
time-relative feature is computed against a ``now`` reference derived from the
data itself (the latest observed timestamp) rather than ``time.time()``. This
keeps features stable and reproducible regardless of when the service runs.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass, field

MOTES_PER_CSPR = 1_000_000_000
SECONDS_PER_DAY = 86_400
WINDOW_30D_SECONDS = 30 * SECONDS_PER_DAY


# ---------------------------------------------------------------------------
# Parsing helpers
# ---------------------------------------------------------------------------

def to_motes(value) -> int:
    """Coerce a motes field (string | int | float | None) to an int.

    The API serializes ``bigint`` motes as decimal strings; defensive parsing
    keeps the rest of the pipeline numeric.
    """
    if value is None:
        return 0
    if isinstance(value, bool):  # guard: bool is a subclass of int
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    text = str(value).strip()
    if not text:
        return 0
    try:
        return int(text)
    except ValueError:
        # Tolerate scientific notation / decimals in motes strings.
        return int(float(text))


def motes_to_cspr(motes: int) -> float:
    """Convert motes to CSPR as a float (presentation / scaling only)."""
    return motes / MOTES_PER_CSPR


def _revenue_events(agent: dict) -> list[dict]:
    events = agent.get("x402_revenue_history") or []
    return [e for e in events if isinstance(e, dict)]


def _timestamps_for_agent(agent: dict, receipts: list[dict]) -> list[int]:
    """All revenue timestamps for an agent: its history plus receipts it sold."""
    stamps: list[int] = []
    for ev in _revenue_events(agent):
        ts = ev.get("timestamp")
        if isinstance(ts, (int, float)):
            stamps.append(int(ts))
    agent_id = agent.get("agent_id")
    for r in receipts:
        if r.get("seller_agent") == agent_id:
            ts = r.get("timestamp")
            if isinstance(ts, (int, float)):
                stamps.append(int(ts))
    return stamps


def reference_now(agents: list[dict], receipts: list[dict]) -> int:
    """Pick a stable 'now' = latest timestamp anywhere in the dataset.

    Using a data-derived clock makes 30-day windows meaningful even when the
    demo seeds future-dated timestamps.
    """
    latest = 0
    for a in agents:
        for ev in _revenue_events(a):
            ts = ev.get("timestamp")
            if isinstance(ts, (int, float)):
                latest = max(latest, int(ts))
        reg = a.get("registered_at")
        if isinstance(reg, (int, float)):
            latest = max(latest, int(reg))
    for r in receipts:
        ts = r.get("timestamp")
        if isinstance(ts, (int, float)):
            latest = max(latest, int(ts))
    return latest


# ---------------------------------------------------------------------------
# Core statistical primitives
# ---------------------------------------------------------------------------

def herfindahl_index(weights: list[float]) -> float:
    """Normalized Herfindahl–Hirschman Index of a distribution.

    HHI = sum(share_i^2) where share_i = weight_i / total. Ranges from
    ~1/n (perfectly diversified) to 1.0 (a single counterparty). This is the
    *raw* HHI; callers may interpret higher = more concentrated = riskier.
    Returns 0.0 for an empty / zero-total distribution.
    """
    total = sum(w for w in weights if w > 0)
    if total <= 0:
        return 0.0
    return sum((w / total) ** 2 for w in weights if w > 0)


def _linear_regression_slope(xs: list[float], ys: list[float]) -> float:
    """Ordinary-least-squares slope of ys on xs. 0.0 if undefined.

    slope = cov(x, y) / var(x). Used for the revenue trend feature.
    """
    n = len(xs)
    if n < 2:
        return 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    var_x = sum((x - mean_x) ** 2 for x in xs)
    if var_x == 0:
        return 0.0
    cov_xy = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n))
    return cov_xy / var_x


# ---------------------------------------------------------------------------
# Feature container
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class AgentFeatures:
    """Engineered features for a single agent (all real, all numeric)."""

    agent_id: str
    service_type: str

    # Revenue dynamics
    revenue_velocity_30d_cspr: float      # CSPR earned in the trailing 30 days
    revenue_total_cspr: float             # lifetime revenue (CSPR)
    revenue_trend_slope: float            # OLS slope of revenue over time (CSPR/day)
    revenue_event_count: int

    # Counterparty / cadence structure
    counterparty_concentration_hhi: float  # HHI over payers (0..1)
    counterparty_count: int
    cadence_mean_interarrival_days: float   # avg gap between receipts (days)
    cadence_cv: float                       # coeff. of variation of inter-arrivals

    # Quality & solvency
    dispute_adjusted_accuracy: float        # accuracy_score * (1 - dispute_rate), 0..100
    dispute_rate: float                     # 0..1
    stake_coverage_ratio: float             # stake / 30d revenue (capped)
    account_age_days: float
    reputation_score: float                 # 0..100 (passthrough, validated)
    total_jobs_completed: int

    def as_dict(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "service_type": self.service_type,
            "revenue_velocity_30d_cspr": self.revenue_velocity_30d_cspr,
            "revenue_total_cspr": self.revenue_total_cspr,
            "revenue_trend_slope": self.revenue_trend_slope,
            "revenue_event_count": self.revenue_event_count,
            "counterparty_concentration_hhi": self.counterparty_concentration_hhi,
            "counterparty_count": self.counterparty_count,
            "cadence_mean_interarrival_days": self.cadence_mean_interarrival_days,
            "cadence_cv": self.cadence_cv,
            "dispute_adjusted_accuracy": self.dispute_adjusted_accuracy,
            "dispute_rate": self.dispute_rate,
            "stake_coverage_ratio": self.stake_coverage_ratio,
            "account_age_days": self.account_age_days,
            "reputation_score": self.reputation_score,
            "total_jobs_completed": self.total_jobs_completed,
        }


# ---------------------------------------------------------------------------
# Individual feature computations
# ---------------------------------------------------------------------------

def revenue_velocity_30d(agent: dict, now: int) -> float:
    """Sum of revenue (CSPR) in the trailing 30-day window ending at ``now``."""
    cutoff = now - WINDOW_30D_SECONDS
    total = 0
    for ev in _revenue_events(agent):
        ts = ev.get("timestamp")
        if isinstance(ts, (int, float)) and ts >= cutoff:
            total += to_motes(ev.get("amount"))
    return motes_to_cspr(total)


def revenue_total(agent: dict) -> float:
    return motes_to_cspr(sum(to_motes(ev.get("amount")) for ev in _revenue_events(agent)))


def revenue_trend_slope(agent: dict, now: int) -> float:
    """OLS slope of cumulative-free per-event revenue vs. time (CSPR per day).

    We regress each event's revenue (CSPR) against its age in days relative to
    ``now`` flipped so that a *positive* slope means revenue is growing toward
    the present. Requires >= 2 events; otherwise 0.0 (flat).
    """
    events = sorted(
        (e for e in _revenue_events(agent) if isinstance(e.get("timestamp"), (int, float))),
        key=lambda e: e["timestamp"],
    )
    if len(events) < 2:
        return 0.0
    xs = [(ev["timestamp"]) / SECONDS_PER_DAY for ev in events]  # days
    ys = [motes_to_cspr(to_motes(ev.get("amount"))) for ev in events]
    # Re-base x to start at 0 for numerical stability.
    x0 = xs[0]
    xs = [x - x0 for x in xs]
    return _linear_regression_slope(xs, ys)


def counterparty_concentration(agent: dict, receipts: list[dict]) -> tuple[float, int]:
    """Herfindahl concentration of an agent's *payers*, weighted by amount.

    Returns ``(hhi, distinct_payer_count)``. A wash-trading pair shows up as
    HHI near 1.0 with a tiny counterparty count.
    """
    agent_id = agent.get("agent_id")
    by_payer: dict[str, int] = {}
    for r in receipts:
        if r.get("seller_agent") == agent_id:
            payer = r.get("payer_agent", "?")
            by_payer[payer] = by_payer.get(payer, 0) + to_motes(r.get("amount"))
    if not by_payer:
        # Fall back to revenue history with no payer dimension: single stream.
        n_events = len(_revenue_events(agent))
        return (1.0 if n_events > 0 else 0.0, 1 if n_events > 0 else 0)
    hhi = herfindahl_index(list(by_payer.values()))
    return hhi, len(by_payer)


def cadence_stats(agent: dict, receipts: list[dict]) -> tuple[float, float]:
    """Inter-arrival cadence of revenue events.

    Returns ``(mean_interarrival_days, coefficient_of_variation)``.

    The coefficient of variation (stdev / mean) is a robust regularity signal:
    organic traffic is bursty (CV well above 0) while scripted wash-trading
    tends to be metronomic (CV near 0). With < 2 gaps both are 0.0.
    """
    stamps = sorted(_timestamps_for_agent(agent, receipts))
    if len(stamps) < 2:
        return 0.0, 0.0
    gaps_days = [
        (stamps[i] - stamps[i - 1]) / SECONDS_PER_DAY for i in range(1, len(stamps))
    ]
    mean_gap = sum(gaps_days) / len(gaps_days)
    if mean_gap <= 0:
        return mean_gap, 0.0
    if len(gaps_days) < 2:
        return mean_gap, 0.0
    stdev_gap = statistics.pstdev(gaps_days)
    return mean_gap, stdev_gap / mean_gap


def dispute_adjusted_accuracy(agent: dict) -> float:
    """accuracy_score scaled down by the dispute rate. Range 0..100."""
    accuracy = _clamp(float(agent.get("accuracy_score", 0) or 0), 0.0, 100.0)
    dispute = _clamp(float(agent.get("dispute_rate", 0) or 0), 0.0, 1.0)
    return accuracy * (1.0 - dispute)


def stake_coverage_ratio(agent: dict, now: int, cap: float = 50.0) -> float:
    """Stake relative to monthly revenue exposure.

    ratio = stake_cspr / max(revenue_velocity_30d_cspr, epsilon), capped.

    Interprets how many months of recent revenue the staked collateral covers.
    A higher ratio is safer (more skin in the game per unit of flow). Agents
    with stake but no recent revenue get the cap (well-collateralized).
    """
    stake_cspr = motes_to_cspr(to_motes(agent.get("stake")))
    rev_30d = revenue_velocity_30d(agent, now)
    if rev_30d <= 0:
        return cap if stake_cspr > 0 else 0.0
    return min(stake_cspr / rev_30d, cap)


def account_age_days(agent: dict, now: int) -> float:
    """Days between registration (or earliest revenue) and ``now``."""
    reg = agent.get("registered_at")
    earliest = None
    if isinstance(reg, (int, float)):
        earliest = int(reg)
    for ev in _revenue_events(agent):
        ts = ev.get("timestamp")
        if isinstance(ts, (int, float)):
            earliest = ts if earliest is None else min(earliest, int(ts))
    if earliest is None:
        return 0.0
    return max(0.0, (now - earliest) / SECONDS_PER_DAY)


def _clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def build_features(agent: dict, receipts: list[dict], now: int) -> AgentFeatures:
    """Engineer the full feature vector for a single agent."""
    hhi, cp_count = counterparty_concentration(agent, receipts)
    mean_gap, cv = cadence_stats(agent, receipts)
    return AgentFeatures(
        agent_id=str(agent.get("agent_id", "")),
        service_type=str(agent.get("service_type", "unknown")),
        revenue_velocity_30d_cspr=revenue_velocity_30d(agent, now),
        revenue_total_cspr=revenue_total(agent),
        revenue_trend_slope=revenue_trend_slope(agent, now),
        revenue_event_count=len(_revenue_events(agent)),
        counterparty_concentration_hhi=hhi,
        counterparty_count=cp_count,
        cadence_mean_interarrival_days=mean_gap,
        cadence_cv=cv,
        dispute_adjusted_accuracy=dispute_adjusted_accuracy(agent),
        dispute_rate=_clamp(float(agent.get("dispute_rate", 0) or 0), 0.0, 1.0),
        stake_coverage_ratio=stake_coverage_ratio(agent, now),
        account_age_days=account_age_days(agent, now),
        reputation_score=_clamp(float(agent.get("reputation_score", 0) or 0), 0.0, 100.0),
        total_jobs_completed=int(agent.get("total_jobs_completed", 0) or 0),
    )


def build_all_features(agents: list[dict], receipts: list[dict]) -> dict[str, AgentFeatures]:
    """Build features for every agent against a single shared 'now' reference."""
    now = reference_now(agents, receipts) or 0
    return {
        str(a.get("agent_id")): build_features(a, receipts, now)
        for a in agents
        if a.get("agent_id")
    }
