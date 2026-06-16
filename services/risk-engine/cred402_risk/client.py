"""Tiny stdlib HTTP client for the Cred402 API.

Fetches ``/api/agents`` and ``/api/receipts``. No third-party dependencies —
just :mod:`urllib.request` and :mod:`json`.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE_URL = "http://localhost:4021"
DEFAULT_TIMEOUT = 10.0


class Cred402APIError(RuntimeError):
    """Raised when the Cred402 API is unreachable or returns a bad response."""


class Cred402Client:
    """Read-only client for the Cred402 protocol API."""

    def __init__(self, base_url: str | None = None, timeout: float = DEFAULT_TIMEOUT):
        self.base_url = (base_url or os.environ.get("CRED402_API", DEFAULT_BASE_URL)).rstrip("/")
        self.timeout = timeout

    def _get(self, path: str):
        url = f"{self.base_url}{path}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.URLError as exc:
            raise Cred402APIError(f"failed to reach {url}: {exc}") from exc
        except OSError as exc:
            raise Cred402APIError(f"failed to reach {url}: {exc}") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise Cred402APIError(f"invalid JSON from {url}: {exc}") from exc

    def get_agents(self) -> list[dict]:
        data = self._get("/api/agents")
        if not isinstance(data, list):
            raise Cred402APIError("/api/agents did not return a list")
        return data

    def get_receipts(self) -> list[dict]:
        data = self._get("/api/receipts")
        if not isinstance(data, list):
            raise Cred402APIError("/api/receipts did not return a list")
        return data

    def fetch_all(self) -> tuple[list[dict], list[dict]]:
        """Fetch agents and receipts together."""
        return self.get_agents(), self.get_receipts()
