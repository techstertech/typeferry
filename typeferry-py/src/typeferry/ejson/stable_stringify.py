"""Canonical JSON output — port of ``typeferry-ts/src/ejson/stable-stringify.ts``.

Recursively orders object keys using JavaScript index enumeration and UTF-16
canonical sorting. Arrays preserve insertion order. See PROTOCOL.md §3.3.
"""

from __future__ import annotations

import json
from typing import Any

_MAX_ARRAY_INDEX = 2**32 - 2


def _array_index(key: str) -> bool:
    return (
        0 < len(key) <= 10 and key.isascii() and key.isdigit()
        and (key == "0" or not key.startswith("0")) and int(key) <= _MAX_ARRAY_INDEX
    )


def javascript_object_order(value: Any, *, canonical: bool = False) -> Any:
    """Reproduce JSON.stringify property order, including canonical UTF-16 keys.

    JavaScript enumerates array-index properties numerically even after a
    canonical sort. Other keys retain insertion order or sort by UTF-16 units.
    """

    if isinstance(value, list):
        return [javascript_object_order(item, canonical=canonical) for item in value]
    if isinstance(value, dict):
        indices = sorted((key for key in value if _array_index(key)), key=int)
        remaining = [key for key in value if not _array_index(key)]
        if canonical:
            remaining.sort(key=lambda key: key.encode("utf-16-be", errors="surrogatepass"))
        return {
            key: javascript_object_order(value[key], canonical=canonical)
            for key in [*indices, *remaining]
        }
    return value


def stable_stringify(value: Any, indent: int | str | None = None) -> str:
    """Produce deterministic JSON output with recursively sorted keys.

    Matches JS ``JSON.stringify`` output conventions:

    * ``ensure_ascii=False`` — JS emits raw Unicode; Python's default
      would escape non-ASCII as ``\\uXXXX``.
    * tight separators when compact — JS produces no spaces without a
      ``space`` argument; Python's default would add them.
    * ``allow_nan=False`` — NaN/Inf MUST be tag-encoded by converters
      before reaching this function.
    """

    return json.dumps(
        javascript_object_order(value, canonical=True),
        indent=indent,
        separators=(",", ":") if indent is None else None,
        ensure_ascii=False,
        allow_nan=False,
    )
