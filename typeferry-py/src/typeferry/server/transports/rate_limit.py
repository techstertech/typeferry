"""Sliding-window rate limiter for HTTP and per-WebSocket calls.

Mirrors the TS express-rate-limit / hono-rate-limit behavior: a
per-key counter within a fixed time window. Default bucket is
``120 requests / 60 s`` (PROTOCOL.md §2.1.5).
"""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RateLimit:
    """Rate-limit configuration.

    Defaults match the TS transports: 120 calls per 60 000 ms.
    """

    max: int = 120
    interval_ms: int = 60_000


class SlidingWindowLimiter:
    """Minimal per-key sliding window counter.

    Thread-safe under the asyncio single-thread model only; if the
    runtime is multi-threaded, wrap :meth:`try_consume` in a lock.
    """

    def __init__(self, limit: RateLimit) -> None:
        self.limit = limit
        self._buckets: dict[str, deque[float]] = {}

    def try_consume(self, key: str) -> tuple[bool, int, int]:
        """Return ``(allowed, remaining, reset_ms)`` for ``key``.

        ``remaining`` counts the allowance LEFT after this call if
        allowed (or the current allowance if denied). ``reset_ms`` is
        the milliseconds until the oldest in-window call expires.
        """

        now = time.monotonic() * 1000
        window_start = now - self.limit.interval_ms

        bucket = self._buckets.get(key)
        if bucket is None:
            bucket = deque()
            self._buckets[key] = bucket

        while bucket and bucket[0] <= window_start:
            bucket.popleft()

        if len(bucket) >= self.limit.max:
            return False, 0, math.ceil(bucket[0] + self.limit.interval_ms - now)

        bucket.append(now)
        reset_ms = math.ceil(bucket[0] + self.limit.interval_ms - now)
        return True, max(0, self.limit.max - len(bucket)), reset_ms
