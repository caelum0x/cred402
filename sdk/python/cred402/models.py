"""Typed data models for the Cred402 protocol.

Every model has a ``from_dict`` classmethod that parses the raw JSON shape
returned by the live API (verified against http://localhost:4021). Parsers are
tolerant: unknown fields are ignored and missing fields fall back to sensible
defaults, so a server adding a field never breaks an older SDK.

CSPR amounts are transported as integer *motes* strings (1 CSPR = 1e9 motes).
Use :func:`motes_to_cspr` / :func:`cspr_to_motes` to convert.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, List, Mapping, Optional

MOTES_PER_CSPR = 1_000_000_000


def motes_to_cspr(motes: Any) -> Decimal:
    """Convert an integer motes value (str/int) to a CSPR :class:`Decimal`.

    Uses Decimal to avoid binary float rounding on financial amounts.
    """
    if motes is None or motes == "":
        return Decimal(0)
    return Decimal(int(motes)) / Decimal(MOTES_PER_CSPR)


def cspr_to_motes(cspr: Any) -> int:
    """Convert a CSPR amount (str/int/float/Decimal) to integer motes."""
    return int((Decimal(str(cspr)) * Decimal(MOTES_PER_CSPR)).to_integral_value())


def _s(d: Mapping[str, Any], key: str, default: str = "") -> str:
    v = d.get(key, default)
    return default if v is None else str(v)


def _i(d: Mapping[str, Any], key: str, default: int = 0) -> int:
    v = d.get(key, default)
    try:
        return int(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _f(d: Mapping[str, Any], key: str, default: float = 0.0) -> float:
    v = d.get(key, default)
    try:
        return float(v) if v is not None else default
    except (TypeError, ValueError):
        return default


def _b(d: Mapping[str, Any], key: str, default: bool = False) -> bool:
    v = d.get(key, default)
    return bool(v) if v is not None else default


@dataclass(frozen=True)
class Agent:
    """An autonomous agent registered on the Cred402 protocol."""

    agent_id: str
    service_type: str
    owner_public_key: str = ""
    agent_public_key: str = ""
    stake_motes: str = "0"
    total_jobs_completed: int = 0
    accuracy_score: int = 0
    dispute_rate: float = 0.0
    reputation_score: int = 0
    credit_score: int = 0
    active: bool = True
    registered_at: int = 0
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def stake_cspr(self) -> Decimal:
        return motes_to_cspr(self.stake_motes)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Agent":
        return cls(
            agent_id=_s(d, "agent_id"),
            service_type=_s(d, "service_type"),
            owner_public_key=_s(d, "owner_public_key"),
            agent_public_key=_s(d, "agent_public_key"),
            stake_motes=_s(d, "stake", "0"),
            total_jobs_completed=_i(d, "total_jobs_completed"),
            accuracy_score=_i(d, "accuracy_score"),
            dispute_rate=_f(d, "dispute_rate"),
            reputation_score=_i(d, "reputation_score"),
            credit_score=_i(d, "credit_score"),
            active=_b(d, "active", True),
            registered_at=_i(d, "registered_at"),
            raw=dict(d),
        )


@dataclass(frozen=True)
class Passport:
    """An agent's credit/reputation passport (v1 ``/agents/:id/passport``)."""

    agent_id: str
    service_type: str
    operator: str = ""
    stake_motes: str = "0"
    reputation_score: int = 0
    credit_score: int = 0
    credit_limit_motes: str = "0"
    outstanding_debt_motes: str = "0"
    total_receipts: int = 0
    total_revenue_motes: str = "0"
    dispute_rate: float = 0.0
    capabilities: List[str] = field(default_factory=list)
    spending_limit_motes: str = "0"
    last_active_at: int = 0
    risk_flags: List[str] = field(default_factory=list)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def credit_limit_cspr(self) -> Decimal:
        return motes_to_cspr(self.credit_limit_motes)

    @property
    def outstanding_debt_cspr(self) -> Decimal:
        return motes_to_cspr(self.outstanding_debt_motes)

    @property
    def total_revenue_cspr(self) -> Decimal:
        return motes_to_cspr(self.total_revenue_motes)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Passport":
        return cls(
            agent_id=_s(d, "agent_id"),
            service_type=_s(d, "service_type"),
            operator=_s(d, "operator"),
            stake_motes=_s(d, "stake", "0"),
            reputation_score=_i(d, "reputation_score"),
            credit_score=_i(d, "credit_score"),
            credit_limit_motes=_s(d, "credit_limit", "0"),
            outstanding_debt_motes=_s(d, "outstanding_debt", "0"),
            total_receipts=_i(d, "total_receipts"),
            total_revenue_motes=_s(d, "total_revenue", "0"),
            dispute_rate=_f(d, "dispute_rate"),
            capabilities=list(d.get("capabilities") or []),
            spending_limit_motes=_s(d, "spending_limit", "0"),
            last_active_at=_i(d, "last_active_at"),
            risk_flags=list(d.get("risk_flags") or []),
            raw=dict(d),
        )


@dataclass(frozen=True)
class CreditLine:
    """A drawn/undrawn credit line for an agent."""

    agent_id: str
    max_credit_motes: str = "0"
    drawn_motes: str = "0"
    interest_rate_bps: int = 0
    origination_fee_bps: int = 0
    health_factor_bps: int = 0
    opened_at: int = 0
    due_timestamp: int = 0
    status: str = "unknown"
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def max_credit_cspr(self) -> Decimal:
        return motes_to_cspr(self.max_credit_motes)

    @property
    def drawn_cspr(self) -> Decimal:
        return motes_to_cspr(self.drawn_motes)

    @property
    def available_cspr(self) -> Decimal:
        return self.max_credit_cspr - self.drawn_cspr

    @property
    def interest_rate_pct(self) -> float:
        return self.interest_rate_bps / 100.0

    @property
    def health_factor(self) -> float:
        return self.health_factor_bps / 10_000.0

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "CreditLine":
        return cls(
            agent_id=_s(d, "agent_id"),
            max_credit_motes=_s(d, "max_credit", "0"),
            drawn_motes=_s(d, "drawn", "0"),
            interest_rate_bps=_i(d, "interest_rate_bps"),
            origination_fee_bps=_i(d, "origination_fee_bps"),
            health_factor_bps=_i(d, "health_factor_bps"),
            opened_at=_i(d, "opened_at"),
            due_timestamp=_i(d, "due_timestamp"),
            status=_s(d, "status", "unknown"),
            raw=dict(d),
        )


@dataclass(frozen=True)
class ReasonCode:
    """A single explainability reason code from the underwriting decision."""

    code: str
    polarity: str = "neutral"
    detail: str = ""

    @property
    def is_positive(self) -> bool:
        return self.polarity == "positive"

    @property
    def is_negative(self) -> bool:
        return self.polarity == "negative"

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ReasonCode":
        return cls(
            code=_s(d, "code"),
            polarity=_s(d, "polarity", "neutral"),
            detail=_s(d, "detail"),
        )


@dataclass(frozen=True)
class CreditDecision:
    """The underwriting decision behind a credit line."""

    policy_version: str = ""
    last_30_day_revenue_motes: str = "0"
    base_limit_motes: str = "0"
    credit_line_motes: str = "0"
    interest_rate_bps: int = 0
    credit_score: int = 0
    stake_multiplier: float = 1.0
    dispute_penalty: float = 1.0
    accuracy_multiplier: float = 1.0
    rationale: List[str] = field(default_factory=list)
    reason_codes: List[ReasonCode] = field(default_factory=list)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def credit_line_cspr(self) -> Decimal:
        return motes_to_cspr(self.credit_line_motes)

    @property
    def interest_rate_pct(self) -> float:
        return self.interest_rate_bps / 100.0

    @property
    def positive_reasons(self) -> List[ReasonCode]:
        return [r for r in self.reason_codes if r.is_positive]

    @property
    def negative_reasons(self) -> List[ReasonCode]:
        return [r for r in self.reason_codes if r.is_negative]

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "CreditDecision":
        return cls(
            policy_version=_s(d, "policy_version"),
            last_30_day_revenue_motes=_s(d, "last_30_day_revenue", "0"),
            base_limit_motes=_s(d, "base_limit", "0"),
            credit_line_motes=_s(d, "credit_line", "0"),
            interest_rate_bps=_i(d, "interest_rate_bps"),
            credit_score=_i(d, "credit_score"),
            stake_multiplier=_f(d, "stake_multiplier", 1.0),
            dispute_penalty=_f(d, "dispute_penalty", 1.0),
            accuracy_multiplier=_f(d, "accuracy_multiplier", 1.0),
            rationale=list(d.get("rationale") or []),
            reason_codes=[ReasonCode.from_dict(r) for r in (d.get("reason_codes") or [])],
            raw=dict(d),
        )


@dataclass(frozen=True)
class CreditExplain:
    """The full credit explanation (decision + fraud + realfi signals)."""

    decision: CreditDecision
    fraud_score: int = 0
    realfi_multiplier: float = 1.0
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def reason_codes(self) -> List[ReasonCode]:
        return self.decision.reason_codes

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "CreditExplain":
        return cls(
            decision=CreditDecision.from_dict(d.get("decision") or {}),
            fraud_score=_i(d, "fraud_score"),
            realfi_multiplier=_f(d, "realfi_multiplier", 1.0),
            raw=dict(d),
        )


@dataclass(frozen=True)
class CreditPool:
    """Aggregate lending-pool state."""

    total_liquidity_motes: str = "0"
    outstanding_credit_motes: str = "0"
    interest_accrued_motes: str = "0"
    defaults: int = 0
    credit_lines: List[CreditLine] = field(default_factory=list)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def total_liquidity_cspr(self) -> Decimal:
        return motes_to_cspr(self.total_liquidity_motes)

    @property
    def outstanding_credit_cspr(self) -> Decimal:
        return motes_to_cspr(self.outstanding_credit_motes)

    @property
    def utilization(self) -> float:
        liq = int(self.total_liquidity_motes or 0)
        if liq == 0:
            return 0.0
        return int(self.outstanding_credit_motes or 0) / liq

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "CreditPool":
        return cls(
            total_liquidity_motes=_s(d, "total_liquidity", "0"),
            outstanding_credit_motes=_s(d, "outstanding_credit", "0"),
            interest_accrued_motes=_s(d, "interest_accrued", "0"),
            defaults=_i(d, "defaults"),
            credit_lines=[CreditLine.from_dict(c) for c in (d.get("creditLines") or [])],
            raw=dict(d),
        )


@dataclass(frozen=True)
class MarketListing:
    """A service listing in the agent marketplace."""

    listing_id: str
    agent_id: str
    category: str = ""
    strategy: str = ""
    base_price_motes: str = "0"
    min_payment_motes: str = "0"
    margin_bps: int = 0
    period_seconds: int = 0
    reputation_score: int = 0
    dispute_rate: float = 0.0
    receipt_count: int = 0
    stake_motes: str = "0"
    supported_chains: List[str] = field(default_factory=list)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def base_price_cspr(self) -> Decimal:
        return motes_to_cspr(self.base_price_motes)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "MarketListing":
        return cls(
            listing_id=_s(d, "listing_id"),
            agent_id=_s(d, "agent_id"),
            category=_s(d, "category"),
            strategy=_s(d, "strategy"),
            base_price_motes=_s(d, "base_price", "0"),
            min_payment_motes=_s(d, "min_payment", "0"),
            margin_bps=_i(d, "margin_bps"),
            period_seconds=_i(d, "period_seconds"),
            reputation_score=_i(d, "reputation_score"),
            dispute_rate=_f(d, "dispute_rate"),
            receipt_count=_i(d, "receipt_count"),
            stake_motes=_s(d, "stake", "0"),
            supported_chains=list(d.get("supported_chains") or []),
            raw=dict(d),
        )


@dataclass(frozen=True)
class EconomicsView:
    """Protocol economics: fee schedule + pool health."""

    fees: Mapping[str, Any] = field(default_factory=dict)
    health: Mapping[str, Any] = field(default_factory=dict)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @property
    def utilization(self) -> float:
        return _f(self.health, "utilization")

    @property
    def realized_apy(self) -> float:
        return _f(self.health, "realized_apy")

    @property
    def risk_flags(self) -> List[str]:
        return list(self.health.get("risk_flags") or [])

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "EconomicsView":
        return cls(
            fees=dict(d.get("fees") or {}),
            health=dict(d.get("health") or {}),
            raw=dict(d),
        )


@dataclass(frozen=True)
class ComplianceCheck:
    name: str
    passed: bool = False
    detail: str = ""

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ComplianceCheck":
        return cls(name=_s(d, "name"), passed=_b(d, "passed"), detail=_s(d, "detail"))


@dataclass(frozen=True)
class ComplianceResult:
    """Sanctions / KYB / jurisdiction screen for an agent."""

    subject: str = ""
    cleared: bool = False
    checks: List[ComplianceCheck] = field(default_factory=list)
    retention: List[Mapping[str, Any]] = field(default_factory=list)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ComplianceResult":
        screen = d.get("screen") or {}
        return cls(
            subject=_s(screen, "subject"),
            cleared=_b(screen, "cleared"),
            checks=[ComplianceCheck.from_dict(c) for c in (screen.get("checks") or [])],
            retention=list(d.get("retention") or []),
            raw=dict(d),
        )


@dataclass(frozen=True)
class Dispute:
    """A dispute opened against a respondent agent."""

    dispute_id: str
    dispute_type: str = ""
    complainant: str = ""
    respondent_agent: str = ""
    status: str = ""
    slash_amount_motes: str = "0"
    opened_at: int = 0
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "Dispute":
        return cls(
            dispute_id=_s(d, "dispute_id"),
            dispute_type=_s(d, "dispute_type"),
            complainant=_s(d, "complainant"),
            respondent_agent=_s(d, "respondent_agent"),
            status=_s(d, "status"),
            slash_amount_motes=_s(d, "slash_amount", "0"),
            opened_at=_i(d, "opened_at"),
            raw=dict(d),
        )


@dataclass(frozen=True)
class ApiKey:
    """A scoped API key minted via the admin surface."""

    id: str = ""
    name: str = ""
    key: Optional[str] = None
    scopes: List[str] = field(default_factory=list)
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> "ApiKey":
        return cls(
            id=_s(d, "id"),
            name=_s(d, "name"),
            key=d.get("key"),
            scopes=list(d.get("scopes") or []),
            raw=dict(d),
        )
