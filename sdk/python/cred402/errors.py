"""Error types for the Cred402 SDK.

The Cred402 API has two surfaces with two error shapes:

* ``/v1`` production routes wrap failures in an envelope
  ``{"success": false, "error": {"code", "message"}, "request_id"}``.
* Raw ``/api`` and ``x402`` routes return ``{"error": "..."}`` with no envelope.

Both collapse into :class:`Cred402Error` so callers only catch one type.
"""

from __future__ import annotations

from typing import Optional


class Cred402Error(Exception):
    """Raised when the Cred402 API returns a non-success response.

    Attributes:
        message: Human readable error message.
        status: HTTP status code (e.g. ``402``, ``404``, ``422``), or ``None``.
        code: Stable machine code from the v1 envelope (e.g. ``not_found``),
            or ``None`` for raw routes.
        request_id: The server-assigned request id from the v1 envelope, if any.
        response_body: The raw decoded JSON body, for debugging.
    """

    def __init__(
        self,
        message: str,
        *,
        status: Optional[int] = None,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        response_body: Optional[object] = None,
    ) -> None:
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id
        self.response_body = response_body
        parts = [message]
        if status is not None:
            parts.append(f"status={status}")
        if code is not None:
            parts.append(f"code={code}")
        if request_id is not None:
            parts.append(f"request_id={request_id}")
        super().__init__(" | ".join(parts))


class Cred402ConfigError(Cred402Error):
    """Raised when the client is constructed with invalid configuration."""


class PaymentRequiredError(Cred402Error):
    """Raised by x402 helpers when a 402 challenge could not be satisfied."""
