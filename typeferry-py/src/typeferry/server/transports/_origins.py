"""Admission shared by HTTP requests and WebSocket upgrades."""

from __future__ import annotations

from collections.abc import Collection


def origin_allowed(
    origin: str | None, origins: Collection[str] | None, *, allow_originless: bool
) -> bool:
    """Treat an omitted allowlist as unrestricted and an empty one as deny-all."""

    if origins is None:
        return True
    if origin is None:
        return allow_originless
    return bool(origin) and origin in origins
