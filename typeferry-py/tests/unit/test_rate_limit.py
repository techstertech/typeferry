"""Rate-limit retention follows the same monotonic window as quota admission."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from typeferry.server.transports.rate_limit import RateLimit, SlidingWindowLimiter


def test_inactive_buckets_expire_when_another_client_arrives(monkeypatch: pytest.MonkeyPatch) -> None:
    now = 0.0
    monkeypatch.setattr(
        "typeferry.server.transports.rate_limit.time",
        SimpleNamespace(monotonic=lambda: now),
    )
    limiter = SlidingWindowLimiter(RateLimit(max=2, interval_ms=1000))

    for suffix in range(10):
        assert limiter.try_consume(f"inactive-{suffix}")[0]

    now = 1.0
    assert limiter.try_consume("new")[0]
    assert set(limiter._buckets) == {"new"}


def test_cleanup_preserves_a_reused_clients_active_quota(monkeypatch: pytest.MonkeyPatch) -> None:
    now = 0.0
    monkeypatch.setattr(
        "typeferry.server.transports.rate_limit.time",
        SimpleNamespace(monotonic=lambda: now),
    )
    limiter = SlidingWindowLimiter(RateLimit(max=2, interval_ms=1000))

    assert limiter.try_consume("active")[0]
    now = 0.2
    assert limiter.try_consume("inactive")[0]
    now = 0.4
    assert limiter.try_consume("active")[0]

    now = 1.2
    assert limiter.try_consume("new")[0]
    assert set(limiter._buckets) == {"active", "new"}
    assert limiter.try_consume("active") == (True, 0, 200)
    assert limiter.try_consume("active") == (False, 0, 200)
