"""Sliding-window rate limiter for HTTP and per-WebSocket calls.

Mirrors the TS express-rate-limit / hono-rate-limit behavior: a
per-key counter within a fixed time window. Default bucket is
``120 requests / 60 s`` (PROTOCOL.md §2.1.5).
"""

from __future__ import annotations

import math
import time
from collections import OrderedDict, deque
from dataclasses import dataclass

MAX_LIMITER_BUCKETS = 100_000


@dataclass(frozen=True, slots=True)
class RateLimit:
    """Rate-limit configuration.

    Defaults match the TS transports: 120 calls per 60 000 ms.
    """

    max: int = 120
    interval_ms: int = 60_000

    def __post_init__(self) -> None:
        if isinstance(self.max, bool) or not isinstance(self.max, int) or self.max <= 0:
            raise ValueError("RateLimit.max must be a positive integer")
        if (
            isinstance(self.interval_ms, bool)
            or not isinstance(self.interval_ms, int)
            or self.interval_ms <= 0
        ):
            raise ValueError("RateLimit.interval_ms must be a positive integer")


class SlidingWindowLimiter:
    """Minimal per-key sliding window counter.

    Thread-safe under the asyncio single-thread model only; if the
    runtime is multi-threaded, wrap :meth:`try_consume` in a lock.
    """

    def __init__(self, limit: RateLimit, *, max_buckets: int = MAX_LIMITER_BUCKETS) -> None:
        if (
            isinstance(max_buckets, bool)
            or not isinstance(max_buckets, int)
            or max_buckets <= 0
        ):
            raise ValueError("max_buckets must be a positive integer")
        self.limit = limit
        self._max_buckets = max_buckets
        self._buckets: OrderedDict[str, deque[float]] = OrderedDict()

    def try_consume(self, key: str) -> tuple[bool, int, int]:
        """Return ``(allowed, remaining, reset_ms)`` for ``key``.

        ``remaining`` counts the allowance LEFT after this call if
        allowed (or the current allowance if denied). ``reset_ms`` is
        the milliseconds until the oldest in-window call expires.
        """

        now = time.monotonic() * 1000
        window_start = now - self.limit.interval_ms

        # Buckets follow their last admitted request. Expiring the oldest first
        # reclaims inactive clients without scanning or resetting active quotas.
        while self._buckets:
            oldest = next(iter(self._buckets.values()))
            if oldest[-1] > window_start:
                break
            self._buckets.popitem(last=False)

        bucket = self._buckets.get(key)
        if bucket is None:
            while len(self._buckets) >= self._max_buckets:
                self._buckets.popitem(last=False)
            bucket = deque()
            self._buckets[key] = bucket

        while bucket and bucket[0] <= window_start:
            bucket.popleft()

        if len(bucket) >= self.limit.max:
            return False, 0, math.ceil(bucket[0] + self.limit.interval_ms - now)

        bucket.append(now)
        self._buckets.move_to_end(key)

        reset_ms = math.ceil(bucket[0] + self.limit.interval_ms - now)
        return True, max(0, self.limit.max - len(bucket)), reset_ms
