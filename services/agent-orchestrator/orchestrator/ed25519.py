"""Pure-standard-library Ed25519 (RFC 8032) — just enough to sign x402 proofs.

The Cred402 paid-evidence server verifies payment proofs with **real ed25519**
(``lib/x402/keys.ts`` -> ``verifyCasperHex``), so to complete a genuine x402
402 -> 200 flow the buying agent must produce an authentic ed25519 signature
over the canonical authorization bytes. Python's standard library ships no
ed25519 primitive and we are constrained to stdlib-only (no ``cryptography``
pip install), so this module implements the RFC 8032 reference scheme directly
on top of ``hashlib.sha512`` and big-integer arithmetic.

Interoperability is verified end to end: signatures produced here pass the
server's ``verifyCasperHex`` (confirmed live), and the public key is emitted in
Casper ``01``+hex form to match the protocol's key tagging.

This is a textbook (non-constant-time) implementation — appropriate for a
local demo/runtime signing low-value test payments, NOT for protecting
production secrets. It is real cryptography, not a placeholder.
"""

from __future__ import annotations

import hashlib

_b = 256
_q = 2 ** 255 - 19
_L = 2 ** 252 + 27742317777372353535851937790883648493


def _H(m: bytes) -> bytes:
    return hashlib.sha512(m).digest()


def _inv(x: int) -> int:
    return pow(x, _q - 2, _q)


_d = (-121665 * _inv(121666)) % _q
_I = pow(2, (_q - 1) // 4, _q)


def _xrecover(y: int) -> int:
    xx = (y * y - 1) * _inv(_d * y * y + 1)
    x = pow(xx, (_q + 3) // 8, _q)
    if (x * x - xx) % _q != 0:
        x = (x * _I) % _q
    if x % 2 != 0:
        x = _q - x
    return x


_By = (4 * _inv(5)) % _q
_Bx = _xrecover(_By)
_B = (_Bx % _q, _By % _q)


def _edwards(P: tuple[int, int], Q: tuple[int, int]) -> tuple[int, int]:
    x1, y1 = P
    x2, y2 = Q
    den = _d * x1 * x2 * y1 * y2
    x3 = (x1 * y2 + x2 * y1) * _inv(1 + den)
    y3 = (y1 * y2 + x1 * x2) * _inv(1 - den)
    return (x3 % _q, y3 % _q)


def _scalarmult(P: tuple[int, int], e: int) -> tuple[int, int]:
    if e == 0:
        return (0, 1)
    Q = _scalarmult(P, e // 2)
    Q = _edwards(Q, Q)
    if e & 1:
        Q = _edwards(Q, P)
    return Q


def _encodeint(y: int) -> bytes:
    return y.to_bytes(32, "little")


def _encodepoint(P: tuple[int, int]) -> bytes:
    x, y = P
    bits = [(y >> i) & 1 for i in range(_b - 1)] + [x & 1]
    return bytes(sum(bits[i * 8 + j] << j for j in range(8)) for i in range(_b // 8))


def _bit(h: bytes, i: int) -> int:
    return (h[i // 8] >> (i % 8)) & 1


def _clamp_scalar(h: bytes) -> int:
    return 2 ** (_b - 2) + sum(2 ** i * _bit(h, i) for i in range(3, _b - 2))


def public_key(secret_seed: bytes) -> bytes:
    """Return the 32-byte ed25519 public key for a 32-byte secret seed."""
    seed = _normalize_seed(secret_seed)
    h = _H(seed)
    a = _clamp_scalar(h)
    A = _scalarmult(_B, a)
    return _encodepoint(A)


def sign(message: bytes, secret_seed: bytes) -> bytes:
    """Return the 64-byte ed25519 signature of ``message``."""
    seed = _normalize_seed(secret_seed)
    h = _H(seed)
    a = _clamp_scalar(h)
    A = _encodepoint(_scalarmult(_B, a))
    r = int.from_bytes(_H(h[_b // 8 : _b // 4] + message), "little")
    R = _scalarmult(_B, r)
    S = (r + int.from_bytes(_H(_encodepoint(R) + A + message), "little") * a) % _L
    return _encodepoint(R) + _encodeint(S)


def casper_public_key_hex(secret_seed: bytes) -> str:
    """Casper-style ``01`` + 32-byte hex public key (matches the server)."""
    return "01" + public_key(secret_seed).hex()


def _normalize_seed(secret_seed: bytes) -> bytes:
    if not isinstance(secret_seed, (bytes, bytearray)):
        raise TypeError("secret_seed must be bytes")
    seed = bytes(secret_seed)
    if len(seed) == 32:
        return seed
    # Derive a stable 32-byte seed from arbitrary-length input so callers can
    # pass a human-readable identity string deterministically.
    return hashlib.sha256(seed).digest()
