"""JWT sign/verify/decode — port of ``typeferry-ts/src/auth/server/jwt-utils.ts``.

Uses :mod:`pyjwt`. Wire claims use camelCase (``userId``, ``sessionId``)
to match tokens issued by the TS server; the Python payload type uses
snake_case field names and this module translates at the boundary.
"""

from __future__ import annotations

import re
import time
from typing import Any

try:
    import jwt as pyjwt
except ImportError as _exc:  # pragma: no cover
    raise RuntimeError(
        "typeferry.auth.jwt_utils requires the 'auth' extra: "
        "pip install 'typeferry-py[auth]'"
    ) from _exc

from typeferry.auth.types import AccessTokenPayload, AuthConfig

_BEARER_RE = re.compile(r"^Bearer\s+", re.IGNORECASE)


_ALLOWED_ALGORITHMS = frozenset({"HS256", "HS384", "HS512"})


def _validate_config(config: AuthConfig) -> None:
    if not isinstance(config.secret, str) or not config.secret:
        raise ValueError("JWT secret must be a non-empty string")
    if config.algorithm not in _ALLOWED_ALGORITHMS:
        raise ValueError(f"Unsupported JWT algorithm: {config.algorithm}")


def _payload_to_wire(payload: AccessTokenPayload) -> dict[str, Any]:
    wire: dict[str, Any] = {
        "userId": payload.user_id,
        "sessionId": payload.session_id,
        "iat": payload.iat,
        "exp": payload.exp,
    }
    if payload.claims is not None:
        wire["claims"] = payload.claims
    return wire


def _payload_from_wire(decoded: dict[str, Any]) -> AccessTokenPayload:
    user_id = decoded["userId"]
    session_id = decoded["sessionId"]
    iat = decoded["iat"]
    exp = decoded["exp"]
    if not isinstance(user_id, str) or not user_id:
        raise ValueError("Invalid userId claim")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("Invalid sessionId claim")
    if isinstance(iat, bool) or not isinstance(iat, (int, float)):
        raise ValueError("Invalid iat claim")
    if isinstance(exp, bool) or not isinstance(exp, (int, float)):
        raise ValueError("Invalid exp claim")
    return AccessTokenPayload(
        user_id=user_id,
        session_id=session_id,
        iat=int(iat),
        exp=int(exp),
        claims=decoded.get("claims") if isinstance(decoded.get("claims"), dict) else None,
    )


def sign_access_token(payload: AccessTokenPayload, config: AuthConfig) -> str:
    """Sign an access token with the configured algorithm.

    Always passes an explicit ``algorithms`` list to the verifier to
    prevent algorithm-confusion attacks (PROTOCOL.md §8.2).
    """

    _validate_config(config)
    wire = _payload_to_wire(payload)
    result = pyjwt.encode(wire, config.secret, algorithm=config.algorithm)
    return result if isinstance(result, str) else result.decode("utf-8")


def verify_access_token(
    token: str, config: AuthConfig
) -> AccessTokenPayload | None:
    """Verify and decode an access token; returns None on any failure."""

    try:
        _validate_config(config)
        clean_token = _BEARER_RE.sub("", token)
        decoded = pyjwt.decode(
            clean_token,
            config.secret,
            algorithms=[config.algorithm],
            options={"require": ["exp", "iat"]},
        )
    except Exception:
        return None

    if not isinstance(decoded, dict):
        return None

    iat = decoded.get("iat")
    if isinstance(iat, bool) or not isinstance(iat, (int, float)):
        return None
    now = time.time()
    max_age = config.access_token_expiry_minutes * 60
    if (now - iat) > max_age or iat > (now + 5):
        return None

    try:
        return _payload_from_wire(decoded)
    except (KeyError, ValueError, TypeError):
        return None


def decode_token(token: str) -> AccessTokenPayload | None:
    """Decode a token WITHOUT verifying the signature.

    Intended for inspection only (e.g. reading claims on an expired
    token). Callers MUST NOT trust the contents.
    """

    try:
        clean_token = _BEARER_RE.sub("", token)
        decoded = pyjwt.decode(
            clean_token, options={"verify_signature": False, "verify_exp": False}
        )
    except Exception:
        return None

    if not isinstance(decoded, dict):
        return None

    try:
        return _payload_from_wire(decoded)
    except (KeyError, ValueError, TypeError):
        return None
