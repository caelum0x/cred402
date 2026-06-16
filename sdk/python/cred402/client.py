"""Cred402Client — a zero-dependency Python client for the Cred402 protocol.

Talks to both API surfaces of the Cred402 server:

* ``/v1`` production routes — responses are wrapped in an envelope
  ``{"success", "data", "request_id"}``. Auth via ``Authorization: Bearer`` or
  ``X-Api-Key``. Mutations accept an ``Idempotency-Key`` header.
* Raw ``/api`` routes — bare JSON, no envelope.

The client unwraps the envelope automatically, raises :class:`Cred402Error` on
any failure, and exposes resource namespaces (``client.agents``,
``client.credit`` …) mirroring the REST surface.

Uses only the Python standard library (``urllib.request``). Target: Python 3.10+.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Mapping, Optional, Tuple

from . import models
from .errors import Cred402ConfigError, Cred402Error

DEFAULT_BASE_URL = "http://localhost:4021"
DEFAULT_TIMEOUT = 30.0
_USER_AGENT = "cred402-python-sdk/0.1.0"


class Cred402Client:
    """Synchronous client for the Cred402 API.

    Args:
        base_url: Server origin, e.g. ``http://localhost:4021``.
        api_key: Optional bearer/API key. Required only when the server runs
            with auth enabled (production); the dev server allows anonymous reads.
        timeout: Per-request socket timeout in seconds.
        default_headers: Extra headers merged into every request.
    """

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        *,
        api_key: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT,
        default_headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        if not base_url or not base_url.startswith(("http://", "https://")):
            raise Cred402ConfigError(f"base_url must be an http(s) URL, got {base_url!r}")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.default_headers = dict(default_headers or {})

        # Resource namespaces.
        self.agents = _Agents(self)
        self.credit = _Credit(self)
        self.marketplace = _Marketplace(self)
        self.economics = _Economics(self)
        self.realfi = _RealFi(self)
        self.compliance = _Compliance(self)
        self.discovery = _Discovery(self)
        self.disputes = _Disputes(self)
        self.admin = _Admin(self)
        self.webhooks = _Webhooks(self)

    # -- transport -----------------------------------------------------------

    def request(
        self,
        method: str,
        path: str,
        *,
        body: Optional[Mapping[str, Any]] = None,
        query: Optional[Mapping[str, Any]] = None,
        idempotency_key: Optional[str] = None,
        unwrap: bool = True,
    ) -> Any:
        """Perform an HTTP request and return the decoded payload.

        For ``/v1`` routes the envelope is unwrapped to ``data`` when
        ``unwrap`` is True. Failures (non-2xx, ``success: false``, or a raw
        ``{"error": ...}`` body) raise :class:`Cred402Error`.
        """
        url = self.base_url + path
        if query:
            filtered = {k: v for k, v in query.items() if v is not None}
            if filtered:
                url = f"{url}?{urllib.parse.urlencode(filtered)}"

        headers = {
            "Accept": "application/json",
            "User-Agent": _USER_AGENT,
            **self.default_headers,
        }
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        data: Optional[bytes] = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=data, headers=headers, method=method.upper())
        status, payload = self._send(req)
        return self._handle(status, payload, unwrap=unwrap)

    def _send(self, req: "urllib.request.Request") -> Tuple[int, Any]:
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, _safe_json(raw)
        except urllib.error.HTTPError as exc:  # 4xx / 5xx still carry a JSON body
            raw = exc.read().decode("utf-8") if exc.fp else ""
            return exc.code, _safe_json(raw)
        except urllib.error.URLError as exc:
            raise Cred402Error(
                f"could not reach Cred402 server at {self.base_url}: {exc.reason}"
            ) from exc

    @staticmethod
    def _handle(status: int, payload: Any, *, unwrap: bool) -> Any:
        # v1 envelope path.
        if isinstance(payload, Mapping) and "success" in payload:
            if payload.get("success") is True:
                return payload.get("data") if unwrap else payload
            err = payload.get("error") or {}
            raise Cred402Error(
                err.get("message", "request failed"),
                status=status,
                code=err.get("code"),
                request_id=payload.get("request_id"),
                response_body=payload,
            )
        # Raw route error shape: {"error": "..."}.
        if isinstance(payload, Mapping) and "error" in payload and status >= 400:
            raise Cred402Error(str(payload["error"]), status=status, response_body=payload)
        if status >= 400:
            raise Cred402Error(f"HTTP {status}", status=status, response_body=payload)
        return payload

    def raw_request_with_headers(
        self, method: str, path: str, *, headers: Optional[Mapping[str, str]] = None
    ) -> Tuple[int, Dict[str, str], Any]:
        """Low-level call returning ``(status, response_headers, body)``.

        Used by x402 flows that need the 402 status + ``X-Payment-*`` headers
        without raising on the non-2xx status.
        """
        url = self.base_url + path
        merged = {"Accept": "application/json", "User-Agent": _USER_AGENT, **self.default_headers}
        if self.api_key:
            merged["Authorization"] = f"Bearer {self.api_key}"
        if headers:
            merged.update(headers)
        req = urllib.request.Request(url, headers=merged, method=method.upper())
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
                return resp.status, dict(resp.headers.items()), _safe_json(raw)
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8") if exc.fp else ""
            return exc.code, dict(exc.headers.items()), _safe_json(raw)
        except urllib.error.URLError as exc:
            raise Cred402Error(
                f"could not reach Cred402 server at {self.base_url}: {exc.reason}"
            ) from exc

    # -- convenience ---------------------------------------------------------

    def health(self) -> Dict[str, Any]:
        """GET /v1/health — returns ``{ok, env, policy}``."""
        return self.request("GET", "/v1/health")

    def run_demo(self, *, dispute: bool = False) -> Dict[str, Any]:
        """POST /api/demo/run (raw route) — seed the ledger with demo activity.

        Returns the raw ``{"scenes": [...]}`` payload. Set ``dispute=True`` to
        run the dispute variant (POST /api/demo/dispute).
        """
        path = "/api/demo/dispute" if dispute else "/api/demo/run"
        return self.request("POST", path, body={})


def _safe_json(raw: str) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"_non_json_body": raw}


class _Resource:
    def __init__(self, client: Cred402Client) -> None:
        self._c = client


class _Agents(_Resource):
    def list(self) -> List[models.Agent]:
        data = self._c.request("GET", "/v1/agents")
        return [models.Agent.from_dict(a) for a in (data or [])]

    def get(self, agent_id: str) -> models.Agent:
        data = self._c.request("GET", f"/v1/agents/{urllib.parse.quote(agent_id)}")
        return models.Agent.from_dict(data)

    def register(
        self,
        agent_id: str,
        service_type: str,
        *,
        agent_public_key: Optional[str] = None,
        owner_public_key: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> models.Passport:
        """POST /v1/agents — register an agent, returns its initial passport."""
        body: Dict[str, Any] = {"agent_id": agent_id, "service_type": service_type}
        if agent_public_key is not None:
            body["agent_public_key"] = agent_public_key
        if owner_public_key is not None:
            body["owner_public_key"] = owner_public_key
        data = self._c.request("POST", "/v1/agents", body=body, idempotency_key=idempotency_key)
        return models.Passport.from_dict(data)

    def passport(self, agent_id: str) -> models.Passport:
        data = self._c.request("GET", f"/v1/agents/{urllib.parse.quote(agent_id)}/passport")
        return models.Passport.from_dict(data)

    def benchmark(self, agent_id: str) -> Dict[str, Any]:
        """GET /v1/agents/:id/benchmark — percentile vs the service-type cohort."""
        return self._c.request("GET", f"/v1/agents/{urllib.parse.quote(agent_id)}/benchmark")

    def history(self, agent_id: str) -> Dict[str, Any]:
        """GET /v1/agents/:id/history — the agent's chronological credit file."""
        return self._c.request("GET", f"/v1/agents/{urllib.parse.quote(agent_id)}/history")


class _Credit(_Resource):
    def pool(self) -> models.CreditPool:
        data = self._c.request("GET", "/v1/credit/pool")
        return models.CreditPool.from_dict(data)

    def explain(self, agent_id: str) -> models.CreditExplain:
        data = self._c.request("GET", f"/v1/agents/{urllib.parse.quote(agent_id)}/credit-explain")
        return models.CreditExplain.from_dict(data)

    def credit_line(self, agent_id: str) -> models.CreditLine:
        """GET /v1/agents/:id/credit-line — current line for the agent."""
        data = self._c.request("GET", f"/v1/agents/{urllib.parse.quote(agent_id)}/credit-line")
        return models.CreditLine.from_dict(data)

    def open_line(
        self,
        agent_id: str,
        *,
        term_days: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Tuple[models.CreditDecision, models.CreditLine]:
        """POST /v1/credit/lines — underwrite + open a line.

        Returns ``(decision, line)``.
        """
        body: Dict[str, Any] = {"agent_id": agent_id}
        if term_days is not None:
            body["term_days"] = term_days
        data = self._c.request("POST", "/v1/credit/lines", body=body, idempotency_key=idempotency_key)
        decision = models.CreditDecision.from_dict(data.get("decision") or {})
        line = models.CreditLine.from_dict(data.get("line") or {})
        return decision, line

    def draw(
        self,
        line_id: str,
        amount_cspr: float,
        *,
        idempotency_key: Optional[str] = None,
    ) -> models.CreditLine:
        """POST /v1/credit/lines/:id/draw — ``line_id`` is the agent_id."""
        data = self._c.request(
            "POST",
            f"/v1/credit/lines/{urllib.parse.quote(line_id)}/draw",
            body={"amount_cspr": amount_cspr},
            idempotency_key=idempotency_key,
        )
        return models.CreditLine.from_dict(data)

    def repay(
        self,
        line_id: str,
        amount_cspr: float,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/credit/lines/:id/repay — returns ``{line, interest}``."""
        data = self._c.request(
            "POST",
            f"/v1/credit/lines/{urllib.parse.quote(line_id)}/repay",
            body={"amount_cspr": amount_cspr},
            idempotency_key=idempotency_key,
        )
        line = models.CreditLine.from_dict(data.get("line") or {})
        return {"line": line, "interest_motes": str(data.get("interest", "0"))}

    def portfolio(self) -> Dict[str, Any]:
        """GET /v1/credit/portfolio — LP portfolio & concentration (HHI) report."""
        return self._c.request("GET", "/v1/credit/portfolio")

    def simulate(
        self,
        monthly_revenue_cspr: float,
        *,
        reputation: Optional[float] = None,
        stake_cspr: Optional[float] = None,
        accuracy: Optional[float] = None,
        dispute_rate: Optional[float] = None,
        jobs_completed: Optional[int] = None,
        service_type: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/credit/simulate — read-only what-if underwriting preview."""
        body: Dict[str, Any] = {"monthly_revenue_cspr": monthly_revenue_cspr}
        for key, val in (
            ("reputation", reputation),
            ("stake_cspr", stake_cspr),
            ("accuracy", accuracy),
            ("dispute_rate", dispute_rate),
            ("jobs_completed", jobs_completed),
            ("service_type", service_type),
        ):
            if val is not None:
                body[key] = val
        return self._c.request("POST", "/v1/credit/simulate", body=body)

    def offers(self, agent_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """GET /v1/credit/offers — list pre-approval offers (optionally per agent)."""
        path = "/v1/credit/offers"
        if agent_id is not None:
            path += f"?agent_id={urllib.parse.quote(agent_id)}"
        return self._c.request("GET", path) or []

    def issue_offer(
        self,
        agent_id: str,
        *,
        ttl_seconds: Optional[int] = None,
        term_seconds: Optional[int] = None,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/credit/offers — issue a time-bounded pre-approval offer."""
        body: Dict[str, Any] = {"agent_id": agent_id}
        if ttl_seconds is not None:
            body["ttl_seconds"] = ttl_seconds
        if term_seconds is not None:
            body["term_seconds"] = term_seconds
        return self._c.request("POST", "/v1/credit/offers", body=body, idempotency_key=idempotency_key)

    def accept_offer(self, offer_id: str, *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/credit/offers/:id/accept — open a line at the offered terms."""
        return self._c.request(
            "POST", f"/v1/credit/offers/{urllib.parse.quote(offer_id)}/accept", idempotency_key=idempotency_key
        )

    def decline_offer(self, offer_id: str, *, idempotency_key: Optional[str] = None) -> Dict[str, Any]:
        """POST /v1/credit/offers/:id/decline — decline a pending offer."""
        return self._c.request(
            "POST", f"/v1/credit/offers/{urllib.parse.quote(offer_id)}/decline", idempotency_key=idempotency_key
        )


class _Discovery(_Resource):
    def search(
        self,
        *,
        service_type: Optional[str] = None,
        min_reputation: Optional[int] = None,
        min_score: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> Dict[str, Any]:
        """GET /v1/discovery — rank agents by the composite discovery score."""
        params = []
        for key, val in (
            ("service_type", service_type),
            ("min_reputation", min_reputation),
            ("min_score", min_score),
            ("limit", limit),
        ):
            if val is not None:
                params.append(f"{key}={urllib.parse.quote(str(val))}")
        path = "/v1/discovery" + ("?" + "&".join(params) if params else "")
        return self._c.request("GET", path)

    def attestation_graph(self) -> Dict[str, Any]:
        """GET /v1/attestations/graph — the web-of-trust graph."""
        return self._c.request("GET", "/v1/attestations/graph")

    def attest(
        self, frm: str, to: str, note: str = "", *, idempotency_key: Optional[str] = None
    ) -> Dict[str, Any]:
        """POST /v1/attestations — vouch for another agent."""
        return self._c.request(
            "POST", "/v1/attestations", body={"from": frm, "to": to, "note": note}, idempotency_key=idempotency_key
        )


class _Marketplace(_Resource):
    def list(self) -> List[models.MarketListing]:
        data = self._c.request("GET", "/v1/marketplace")
        listings = data if isinstance(data, list) else (data or {}).get("listings", [])
        return [models.MarketListing.from_dict(m) for m in (listings or [])]


class _Economics(_Resource):
    def get(self) -> models.EconomicsView:
        data = self._c.request("GET", "/v1/economics")
        return models.EconomicsView.from_dict(data)


class _RealFi(_Resource):
    def get(self) -> Dict[str, Any]:
        """GET /v1/realfi — ``{fiatReceipts, operatorVerifications, attestations}``."""
        return self._c.request("GET", "/v1/realfi")

    def verify_operator(
        self,
        operator_id: str,
        *,
        verification_level: str = "business_verified",
        jurisdiction: str = "US",
        verification_reference: str,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/realfi/operators."""
        return self._c.request(
            "POST",
            "/v1/realfi/operators",
            body={
                "operator_id": operator_id,
                "verification_level": verification_level,
                "jurisdiction": jurisdiction,
                "verification_reference": verification_reference,
            },
            idempotency_key=idempotency_key,
        )

    def record_fiat_receipt(
        self,
        *,
        seller_agent: str,
        operator_id: str,
        amount: str,
        provider_event_id: str,
        provider_receipt_id: str,
        currency: str = "USD",
        service_type: str = "rwa.weather_risk",
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/realfi/fiat-receipts."""
        return self._c.request(
            "POST",
            "/v1/realfi/fiat-receipts",
            body={
                "seller_agent": seller_agent,
                "operator_id": operator_id,
                "amount": amount,
                "currency": currency,
                "service_type": service_type,
                "provider_event_id": provider_event_id,
                "provider_receipt_id": provider_receipt_id,
            },
            idempotency_key=idempotency_key,
        )


class _Compliance(_Resource):
    def check(self, agent_id: str) -> models.ComplianceResult:
        data = self._c.request("GET", f"/v1/compliance/agents/{urllib.parse.quote(agent_id)}")
        return models.ComplianceResult.from_dict(data)


class _Disputes(_Resource):
    def list(self) -> List[models.Dispute]:
        """GET /api/disputes — raw route (no v1 list endpoint)."""
        data = self._c.request("GET", "/api/disputes")
        return [models.Dispute.from_dict(d) for d in (data or [])]

    def open(
        self,
        respondent_agent: str,
        *,
        dispute_type: str = "bad_evidence",
        note: str = "opened via Python SDK",
        receipt_id: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> models.Dispute:
        """POST /v1/disputes."""
        body: Dict[str, Any] = {
            "respondent_agent": respondent_agent,
            "dispute_type": dispute_type,
            "note": note,
        }
        if receipt_id is not None:
            body["receipt_id"] = receipt_id
        data = self._c.request("POST", "/v1/disputes", body=body, idempotency_key=idempotency_key)
        return models.Dispute.from_dict(data)


class _Admin(_Resource):
    def create_api_key(
        self,
        name: str,
        scopes: List[str],
        *,
        idempotency_key: Optional[str] = None,
    ) -> models.ApiKey:
        """POST /v1/admin/api-keys — requires an admin-scoped key."""
        data = self._c.request(
            "POST",
            "/v1/admin/api-keys",
            body={"name": name, "scopes": scopes},
            idempotency_key=idempotency_key,
        )
        return models.ApiKey.from_dict(data)


class _Webhooks(_Resource):
    def subscribe(
        self,
        url: str,
        events: Optional[List[str]] = None,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Dict[str, Any]:
        """POST /v1/webhooks — requires an admin-scoped key."""
        return self._c.request(
            "POST",
            "/v1/webhooks",
            body={"url": url, "events": events if events is not None else ["*"]},
            idempotency_key=idempotency_key,
        )
