"""Auth layer: JWT sign/verify, cookie serialization, device parsing,
and the in-memory session manager with rotation + grace-period +
theft detection."""

from __future__ import annotations

import time

import pytest

from typeferry.auth import (
    AccessTokenPayload,
    AuthConfig,
    CookieOptions,
    InMemorySessionManager,
    clear_refresh_token_cookie,
    decode_token,
    get_refresh_token_from_cookie_header,
    parse_device_info,
    set_refresh_token_cookie,
    sign_access_token,
    verify_access_token,
)


def _config() -> AuthConfig:
    return AuthConfig(secret="unit-test-secret")


# ---------------------------------------------------------------------------
# JWT
# ---------------------------------------------------------------------------


def test_sign_and_verify_round_trip() -> None:
    config = _config()
    now = int(time.time())
    payload = AccessTokenPayload(
        user_id="u1", session_id="s1", iat=now, exp=now + 900
    )

    token = sign_access_token(payload, config)
    decoded = verify_access_token(token, config)
    assert decoded is not None
    assert decoded.user_id == "u1"
    assert decoded.session_id == "s1"
    assert decoded.iat == now
    assert decoded.exp == now + 900


def test_verify_rejects_bad_signature() -> None:
    payload = AccessTokenPayload(
        user_id="u1", session_id="s1", iat=int(time.time()), exp=int(time.time()) + 900
    )
    token = sign_access_token(payload, _config())

    tampered = AuthConfig(secret="different-secret")
    assert verify_access_token(token, tampered) is None


def test_verify_strips_bearer_prefix() -> None:
    payload = AccessTokenPayload(
        user_id="u1", session_id="s1", iat=int(time.time()), exp=int(time.time()) + 900
    )
    token = sign_access_token(payload, _config())
    assert verify_access_token(f"Bearer {token}", _config()) is not None


def test_verify_expired_token_returns_none() -> None:
    now = int(time.time())
    expired = AccessTokenPayload(
        user_id="u1", session_id="s1", iat=now - 3600, exp=now - 1800
    )
    token = sign_access_token(expired, _config())
    assert verify_access_token(token, _config()) is None


def test_decode_token_without_verification() -> None:
    payload = AccessTokenPayload(
        user_id="u1", session_id="s1", iat=int(time.time()), exp=int(time.time()) + 900
    )
    token = sign_access_token(payload, _config())
    decoded = decode_token(token)
    assert decoded is not None
    assert decoded.user_id == "u1"


# ---------------------------------------------------------------------------
# Cookies
# ---------------------------------------------------------------------------


def test_set_cookie_default_flags(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "development")
    header = set_refresh_token_cookie(
        "tok-xyz", CookieOptions(name="bf_refresh", max_age_days=7)
    )
    assert header.startswith("bf_refresh=tok-xyz")
    assert "HttpOnly" in header
    assert "Path=/" in header
    assert "Max-Age=" + str(7 * 86400) in header
    assert "SameSite=Lax" in header
    assert "Secure" not in header  # default unless NODE_ENV=production


def test_set_cookie_secure_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    header = set_refresh_token_cookie(
        "abc", CookieOptions(name="bf_refresh", max_age_days=1)
    )
    assert "Secure" in header


def test_set_cookie_url_encodes_value() -> None:
    header = set_refresh_token_cookie(
        "a=b;c", CookieOptions(name="bf_refresh", max_age_days=1)
    )
    assert header.startswith("bf_refresh=a%3Db%3Bc")


def test_clear_cookie_sets_max_age_zero() -> None:
    header = clear_refresh_token_cookie("bf_refresh")
    assert "Max-Age=0" in header


def test_extract_cookie_from_header() -> None:
    header = "foo=1; bf_refresh=abc%20def; bar=2"
    assert get_refresh_token_from_cookie_header(header, "bf_refresh") == "abc def"


def test_extract_cookie_missing() -> None:
    assert get_refresh_token_from_cookie_header(None, "bf_refresh") is None
    assert get_refresh_token_from_cookie_header("foo=bar", "bf_refresh") is None


# ---------------------------------------------------------------------------
# Device info
# ---------------------------------------------------------------------------


def test_device_info_ip_and_ua() -> None:
    info = parse_device_info(
        {
            "user-agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) "
                "Version/17.0 Safari/605.1.15"
            ),
            "x-forwarded-for": "10.0.0.1",
        },
        remote_address="198.51.100.5",
    )
    assert info.ip == "198.51.100.5"
    assert info.user_agent is not None
    # Either ua-parser is installed (returns typed fields) or it isn't
    # (returns just the raw UA string). Both are acceptable parity
    # targets per PROTOCOL.md §8.
    assert info.browser is None or isinstance(info.browser, str)


def test_device_info_without_ua_returns_only_ip() -> None:
    info = parse_device_info({"x-forwarded-for": "1.2.3.4"}, remote_address="198.51.100.6")
    assert info.ip == "198.51.100.6"
    assert info.user_agent is None


def test_device_info_empty_headers() -> None:
    info = parse_device_info(None)
    assert info.ip is None
    assert info.user_agent is None


# ---------------------------------------------------------------------------
# Session manager
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_session_create_and_refresh() -> None:
    manager = InMemorySessionManager(_config())
    pair = await manager.create_session("user-1")
    assert pair.access_token
    assert pair.refresh_token
    refreshed = await manager.refresh_session(pair.refresh_token)
    assert refreshed is not None
    assert refreshed.refresh_token != pair.refresh_token


@pytest.mark.asyncio
async def test_session_refresh_out_of_grace_revokes_family() -> None:
    config = AuthConfig(secret="x", rotation_grace_period_seconds=0)
    manager = InMemorySessionManager(config)
    pair = await manager.create_session("user-1")

    # First refresh succeeds.
    _ = await manager.refresh_session(pair.refresh_token)

    # Reusing the original token outside grace triggers theft detection.
    refreshed = await manager.refresh_session(pair.refresh_token)
    assert refreshed is None

    # Every session in the family is revoked.
    sessions = await manager.get_user_sessions("user-1")
    assert sessions == []


@pytest.mark.asyncio
async def test_session_refresh_within_grace_returns_replacement() -> None:
    config = AuthConfig(secret="x", rotation_grace_period_seconds=60)
    manager = InMemorySessionManager(config)
    pair = await manager.create_session("user-1")

    first_refresh = await manager.refresh_session(pair.refresh_token)
    assert first_refresh is not None

    # Immediately retrying with the original refresh token yields the
    # same replacement pair — not a brand-new rotation.
    grace_retry = await manager.refresh_session(pair.refresh_token)
    assert grace_retry is not None
    assert grace_retry.refresh_token == first_refresh.refresh_token


@pytest.mark.asyncio
async def test_revoke_session_and_all_user_sessions() -> None:
    manager = InMemorySessionManager(_config())
    pair_a = await manager.create_session("user-1")
    pair_b = await manager.create_session("user-1")

    assert len(await manager.get_user_sessions("user-1")) == 2

    removed = await manager.revoke_all_user_sessions("user-1")
    assert removed == 2
    assert await manager.refresh_session(pair_a.refresh_token) is None
    assert await manager.refresh_session(pair_b.refresh_token) is None


@pytest.mark.asyncio
async def test_refresh_expired_session_returns_none(monkeypatch: pytest.MonkeyPatch) -> None:
    config = AuthConfig(secret="x", refresh_token_expiry_days=1)
    manager = InMemorySessionManager(config)
    pair = await manager.create_session("user-1")

    # Advance the clock past the refresh-token expiry.
    real_time = time.time
    monkeypatch.setattr(time, "time", lambda: real_time() + 2 * 86400)
    assert await manager.refresh_session(pair.refresh_token) is None
