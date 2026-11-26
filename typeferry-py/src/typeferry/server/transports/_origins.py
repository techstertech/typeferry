"""Admission shared by HTTP requests and WebSocket upgrades."""

from __future__ import annotations

import logging
import os
from collections.abc import Collection

_log = logging.getLogger(__name__)
_ENV_KEYS = ("TYPEFERRY_ENV", "NODE_ENV", "PYTHON_ENV")


def warn_if_origins_omitted_in_production(
    transport_name: str, origins: Collection[str] | None
) -> None:
    """Emit a warning when a transport runs in production with unrestricted origins."""

    if origins is None and any(os.environ.get(key) == "production" for key in _ENV_KEYS):
        _log.warning(
            "TypeFerry %s transport started without an origins allowlist in production",
            transport_name,
        )


def origin_allowed(
    origin: str | None, origins: Collection[str] | None, *, allow_originless: bool
) -> bool:
    """Treat an omitted allowlist as unrestricted and an empty one as deny-all."""

    if origins is None:
        return True
    if origin is None:
        return allow_originless
    return bool(origin) and origin in origins
