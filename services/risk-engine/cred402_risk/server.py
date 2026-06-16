"""HTTP JSON API for the Cred402 risk + fraud engine.

Built on :mod:`http.server` from the standard library. Routes::

    GET /health                 -> service + upstream health
    GET /risk/score/<agent_id>  -> {pd, credit_score, interest_rate_bps, ...}
    GET /risk/fraud/<agent_id>  -> {fraud_score, flags, in_ring, ring_members}
    GET /risk/portfolio         -> combined scores for all agents (leaderboard)

Live data is fetched from the Cred402 API per request (``CRED402_API`` env,
default ``http://localhost:4021``). The server binds to ``CRED402_RISK_PORT``
(default 8088).

Run::

    python3 cred402_risk/server.py
"""

from __future__ import annotations

import json
import os
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if __package__ in (None, ""):
    # Allow `python3 cred402_risk/server.py` (script mode) by making the
    # package importable, then re-exec as a proper package import.
    import os as _os
    import sys as _sys

    _sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))
    from cred402_risk import credit_score, fraud_graph
    from cred402_risk.client import Cred402APIError, Cred402Client
    from cred402_risk.features import build_all_features
else:
    from . import credit_score, fraud_graph
    from .client import Cred402APIError, Cred402Client
    from .features import build_all_features

DEFAULT_PORT = 8088


# ---------------------------------------------------------------------------
# Engine: pure orchestration over the four modules. Reusable from CLI + server.
# ---------------------------------------------------------------------------

def score_agent(agent_id: str, agents: list[dict], receipts: list[dict]) -> dict | None:
    feats = build_all_features(agents, receipts)
    f = feats.get(agent_id)
    if f is None:
        return None
    return credit_score.assess(f).as_dict()


def fraud_agent(agent_id: str, agents: list[dict], receipts: list[dict]) -> dict | None:
    fraud = fraud_graph.assess_fraud(agents, receipts)
    fa = fraud.get(agent_id)
    if fa is None:
        return None
    return fa.as_dict()


def portfolio(agents: list[dict], receipts: list[dict]) -> dict:
    feats = build_all_features(agents, receipts)
    fraud = fraud_graph.assess_fraud(agents, receipts)
    rows = []
    for agent_id, f in feats.items():
        credit = credit_score.assess(f)
        fa = fraud.get(agent_id)
        rows.append(
            {
                "agent_id": agent_id,
                "service_type": f.service_type,
                "credit_score": credit.credit_score,
                "pd": round(credit.pd, 6),
                "interest_rate_bps": credit.interest_rate_bps,
                "risk_bucket": credit.risk_bucket,
                "confidence_score": round(credit.confidence_score, 4),
                "fraud_score": round(fa.fraud_score, 2) if fa else 0.0,
                "fraud_flags": fa.flags if fa else [],
                "in_ring": fa.in_ring if fa else False,
            }
        )
    # Leaderboard: safest (highest credit, lowest fraud) first.
    rows.sort(key=lambda r: (-r["credit_score"], r["fraud_score"]))
    return {"count": len(rows), "agents": rows}


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------

class RiskHandler(BaseHTTPRequestHandler):
    server_version = "Cred402RiskEngine/0.1"

    # Injected by make_server().
    client: Cred402Client

    def _send_json(self, status: int, body) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args) -> None:  # quieter logging
        return

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        parts = [p for p in path.split("/") if p]

        try:
            if path == "/health":
                return self._handle_health()
            if len(parts) == 3 and parts[0] == "risk" and parts[1] == "score":
                return self._handle_score(urllib.parse.unquote(parts[2]))
            if len(parts) == 3 and parts[0] == "risk" and parts[1] == "fraud":
                return self._handle_fraud(urllib.parse.unquote(parts[2]))
            if path == "/risk/portfolio":
                return self._handle_portfolio()
            return self._send_json(404, {"error": "not found", "path": path})
        except Cred402APIError as exc:
            return self._send_json(502, {"error": "upstream_unreachable", "detail": str(exc)})
        except Exception as exc:  # defensive: never leak a stack trace to clients
            return self._send_json(500, {"error": "internal_error", "detail": str(exc)})

    def _handle_health(self) -> None:
        upstream_ok = True
        detail = "ok"
        try:
            self.client.get_agents()
        except Cred402APIError as exc:
            upstream_ok = False
            detail = str(exc)
        self._send_json(
            200,
            {
                "ok": True,
                "service": "cred402-risk-engine",
                "upstream": self.client.base_url,
                "upstream_ok": upstream_ok,
                "upstream_detail": detail,
            },
        )

    def _handle_score(self, agent_id: str) -> None:
        agents, receipts = self.client.fetch_all()
        result = score_agent(agent_id, agents, receipts)
        if result is None:
            return self._send_json(404, {"error": "agent_not_found", "agent_id": agent_id})
        self._send_json(200, result)

    def _handle_fraud(self, agent_id: str) -> None:
        agents, receipts = self.client.fetch_all()
        result = fraud_agent(agent_id, agents, receipts)
        if result is None:
            return self._send_json(404, {"error": "agent_not_found", "agent_id": agent_id})
        self._send_json(200, result)

    def _handle_portfolio(self) -> None:
        agents, receipts = self.client.fetch_all()
        self._send_json(200, portfolio(agents, receipts))


def make_server(host: str = "0.0.0.0", port: int = DEFAULT_PORT, base_url: str | None = None) -> ThreadingHTTPServer:
    client = Cred402Client(base_url=base_url)

    handler = type("BoundRiskHandler", (RiskHandler,), {"client": client})
    httpd = ThreadingHTTPServer((host, port), handler)
    return httpd


def main() -> None:
    port = int(os.environ.get("CRED402_RISK_PORT", DEFAULT_PORT))
    base_url = os.environ.get("CRED402_API")
    httpd = make_server(port=port, base_url=base_url)
    client_url = base_url or "http://localhost:4021"
    print(f"cred402-risk-engine listening on http://0.0.0.0:{port} (upstream: {client_url})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("shutting down")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
