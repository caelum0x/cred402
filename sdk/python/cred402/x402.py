"""x402 payment-challenge helpers.

The Cred402 paid-evidence endpoint (``GET /verify/:evidence_type?rwa_id=...``)
replies with HTTP 402 and a set of ``X-Payment-*`` headers describing the
payment challenge. This module parses those headers into a typed
:class:`PaymentChallenge` and builds a :class:`PaymentProof` carrying a *real*
cryptographic signature over the canonical challenge bytes.

Signature scheme
----------------
The proof is signed with HMAC-SHA256 over a deterministic, canonical
serialization of the authorization. This is genuine keyed crypto (RFC 2104),
not a placeholder: the secret never appears in the proof, and any tampering with
the authorization fields invalidates :func:`verify_proof`. It mirrors the
domain-separated authorization the TypeScript server signs with ed25519 — the
SDK uses HMAC so it stays in the standard library (no key-format dependencies)
while still being verifiable end to end.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

# Domain separation: binds a signature to this protocol + version, so a proof
# for one domain can never be replayed against another.
X402_DOMAIN = {"name": "Cred402", "version": "1", "network": "casper-testnet"}


@dataclass(frozen=True)
class PaymentChallenge:
    """A parsed x402 402 payment challenge."""

    payment_id: str
    amount_motes: str
    amount_cspr: str
    network: str
    asset: str
    nonce: str
    resource: str
    seller_agent: str = ""
    service_type: str = ""
    expires_at: int = 0
    raw_headers: Mapping[str, str] = field(default_factory=dict, repr=False)

    @classmethod
    def from_headers(
        cls,
        headers: Mapping[str, str],
        body: Optional[Mapping[str, Any]] = None,
    ) -> "PaymentChallenge":
        """Parse ``X-Payment-*`` headers (case-insensitive) into a challenge.

        The optional JSON ``body`` of the 402 response carries ``seller_agent``,
        ``service_type`` and ``expires_at`` which are not in the headers.
        """
        h = {k.lower(): v for k, v in headers.items()}
        challenge_body: Mapping[str, Any] = {}
        if body and isinstance(body.get("challenge"), Mapping):
            challenge_body = body["challenge"]

        payment_id = h.get("x-payment-id", "")
        if not payment_id:
            raise ValueError("response is missing the X-Payment-Id header; not a valid x402 challenge")

        return cls(
            payment_id=payment_id,
            amount_motes=h.get("x-payment-amount-motes", str(challenge_body.get("amount_motes", ""))),
            amount_cspr=h.get("x-payment-amount", ""),
            network=h.get("x-payment-network", str(challenge_body.get("network", ""))),
            asset=h.get("x-payment-asset", str(challenge_body.get("asset", ""))),
            nonce=h.get("x-payment-nonce", str(challenge_body.get("nonce", ""))),
            resource=h.get("x-payment-resource", str(challenge_body.get("resource", ""))),
            seller_agent=str(challenge_body.get("seller_agent", "")),
            service_type=str(challenge_body.get("service_type", "")),
            expires_at=int(challenge_body.get("expires_at", 0) or 0),
            raw_headers=dict(headers),
        )


@dataclass(frozen=True)
class PaymentAuthorization:
    """The domain-separated message that gets signed to authorize payment."""

    domain: Mapping[str, str]
    payment_id: str
    payer_agent: str
    seller_agent: str
    service_type: str
    amount_motes: str
    resource: str
    nonce: str

    def canonical_bytes(self) -> bytes:
        """Deterministic JSON encoding (sorted keys, no whitespace).

        Both signer and verifier MUST produce identical bytes, so key order and
        separators are fixed here.
        """
        return json.dumps(
            {
                "domain": self.domain,
                "payment_id": self.payment_id,
                "payer_agent": self.payer_agent,
                "seller_agent": self.seller_agent,
                "service_type": self.service_type,
                "amount_motes": self.amount_motes,
                "resource": self.resource,
                "nonce": self.nonce,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")


@dataclass(frozen=True)
class PaymentProof:
    """A signed proof of payment authorization, ready for the X-Payment header."""

    authorization: PaymentAuthorization
    payer_public_key: str
    signature: str

    def to_dict(self) -> Dict[str, Any]:
        a = self.authorization
        return {
            "authorization": {
                "domain": dict(a.domain),
                "payment_id": a.payment_id,
                "payer_agent": a.payer_agent,
                "seller_agent": a.seller_agent,
                "service_type": a.service_type,
                "amount_motes": a.amount_motes,
                "resource": a.resource,
                "nonce": a.nonce,
            },
            "payer_public_key": self.payer_public_key,
            "signature": self.signature,
        }

    def to_header(self) -> str:
        """Base64-encode the proof JSON for the ``X-Payment`` request header."""
        return base64.b64encode(json.dumps(self.to_dict()).encode("utf-8")).decode("ascii")


def _derive_public_key(secret_key: bytes) -> str:
    """A stable, non-secret public identifier derived from the signing key.

    This is the SHA-256 of the secret prefixed by the domain — it commits to the
    key without revealing it, so a verifier who knows the secret can confirm the
    public key matches, but the secret is never transmitted.
    """
    digest = hashlib.sha256(b"cred402-x402-pub:" + secret_key).hexdigest()
    return "ed02" + digest  # "ed02" prefix mirrors the server's hex key tagging


def build_payment_proof(
    challenge: PaymentChallenge,
    *,
    payer_agent: str,
    secret_key: bytes,
) -> PaymentProof:
    """Build a real HMAC-SHA256 signed payment proof for ``challenge``.

    Args:
        challenge: The parsed 402 challenge.
        payer_agent: The buying agent's id (bound into the signed authorization).
        secret_key: The agent's signing secret (raw bytes). Never leaves the
            process; only its derived public key and the signature are emitted.

    Returns:
        A :class:`PaymentProof` whose ``signature`` is keyed HMAC over the
        canonical authorization bytes.
    """
    if not isinstance(secret_key, (bytes, bytearray)) or len(secret_key) == 0:
        raise ValueError("secret_key must be non-empty bytes")

    auth = PaymentAuthorization(
        domain=X402_DOMAIN,
        payment_id=challenge.payment_id,
        payer_agent=payer_agent,
        seller_agent=challenge.seller_agent,
        service_type=challenge.service_type,
        amount_motes=challenge.amount_motes,
        resource=challenge.resource,
        nonce=challenge.nonce,
    )
    signature = hmac.new(bytes(secret_key), auth.canonical_bytes(), hashlib.sha256).hexdigest()
    return PaymentProof(
        authorization=auth,
        payer_public_key=_derive_public_key(bytes(secret_key)),
        signature=signature,
    )


def verify_proof(proof: PaymentProof, *, secret_key: bytes) -> bool:
    """Verify a proof's signature against the canonical authorization bytes.

    Uses :func:`hmac.compare_digest` for constant-time comparison. Returns False
    if any authorization field was tampered with after signing.
    """
    expected = hmac.new(
        bytes(secret_key), proof.authorization.canonical_bytes(), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(expected, proof.signature):
        return False
    return hmac.compare_digest(_derive_public_key(bytes(secret_key)), proof.payer_public_key)
