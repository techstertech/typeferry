"""Built-in EJSON converters — port of ``typeferry-ts/src/ejson/built-in-converters.ts``.

The tag forms and order are normative (PROTOCOL.md §3.1):
Date, RegExp, Inf/NaN, Binary, Escape, Custom.

Python type mapping:

* JS ``Date`` ↔ :class:`datetime.datetime` (timezone-aware UTC)
* JS ``RegExp`` ↔ :class:`EJSONRegExp` (source + flags as strings; avoids
  lossy conversion to :class:`re.Pattern`)
* JS ``NaN``/``Infinity``/``-Infinity`` ↔ Python ``float('nan')``,
  ``float('inf')``, ``float('-inf')``
* JS ``Uint8Array`` ↔ Python ``bytes`` / ``bytearray``
* JS custom types ↔ instances implementing :class:`typeferry.ejson.custom_types.CustomType`
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from typeferry.ejson.base64 import decode_base64, encode_base64
from typeferry.ejson.custom_types import (
    get_factory,
    has_type,
    is_custom_type,
)


@dataclass(frozen=True, slots=True)
class EJSONRegExp:
    """Wire-faithful regex container — holds the JS source and flag strings.

    The TS implementation stores ``regexp.source`` (string) and
    ``regexp.flags`` (string like ``"gim"``). Python's :class:`re.Pattern`
    doesn't round-trip these cleanly (JS ``g`` / ``y`` have no Python
    equivalent). Callers who want a compiled pattern should build one
    from :attr:`source` and :attr:`flags` themselves.
    """

    source: str
    flags: str


def _is_inf_or_nan(obj: Any) -> bool:
    if not isinstance(obj, float):
        return False
    return math.isnan(obj) or math.isinf(obj)


def _is_binary(obj: Any) -> bool:
    return isinstance(obj, (bytes, bytearray))


def _has_keys(obj: Any, *keys: str) -> bool:
    if not isinstance(obj, dict):
        return False
    return all(k in obj for k in keys) and len(obj) == len(keys)


# ---------------------------------------------------------------------------
# Converter record
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Converter:
    """Single EJSON tag converter.

    * ``match_json_value(obj)`` — True iff ``obj`` is the JSON-form of this tag
    * ``match_object(obj)`` — True iff ``obj`` is a Python object this converter owns
    * ``to_json_value(obj)`` — serialize the Python object to its tag form
    * ``from_json_value(obj)`` — deserialize the tag form back to a Python object
    """

    match_json_value: Callable[[Any], bool]
    match_object: Callable[[Any], bool]
    to_json_value: Callable[[Any], Any]
    from_json_value: Callable[[Any], Any]


# ---------------------------------------------------------------------------
# Individual converters
# ---------------------------------------------------------------------------


_DATE_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_MAX_JAVASCRIPT_DATE_MS = 8_640_000_000_000_000
_MICROSECONDS_PER_MILLISECOND = 1000
_SECONDS_PER_DAY = 86400


@dataclass(frozen=True, slots=True)
class _EpochMilliseconds:
    """Opaque round-trip value for JavaScript dates beyond datetime's range."""

    milliseconds: int


def _date_to_json(obj: datetime | _EpochMilliseconds) -> dict[str, int]:
    """Encode a datetime as ``{"$date": <ms since epoch>}``.

    Naive datetimes are treated as UTC (matching JS ``Date`` semantics,
    which has no timezone concept beyond the underlying epoch ms).
    """

    if isinstance(obj, _EpochMilliseconds):
        return {"$date": obj.milliseconds}

    native = obj.replace(tzinfo=UTC) if obj.tzinfo is None else obj
    delta = native - _DATE_EPOCH
    microseconds = (
        (delta.days * _SECONDS_PER_DAY + delta.seconds) * 1_000_000 + delta.microseconds
    )
    milliseconds, remainder = divmod(microseconds, _MICROSECONDS_PER_MILLISECOND)

    # Preserve the existing nearest-even microsecond rounding without losing
    # millisecond precision through floating-point timestamps near year 9999.
    half = _MICROSECONDS_PER_MILLISECOND // 2
    if remainder > half or (remainder == half and milliseconds % 2):
        milliseconds += 1
    return {"$date": milliseconds}


def _date_from_json(obj: dict[str, Any]) -> datetime | _EpochMilliseconds:
    ms = obj["$date"]
    if (
        not isinstance(ms, (int, float)) or abs(ms) > _MAX_JAVASCRIPT_DATE_MS
        or (isinstance(ms, float) and not math.isfinite(ms))
    ):
        raise ValueError("Invalid JavaScript date milliseconds")

    milliseconds = int(ms)
    try:
        return _DATE_EPOCH + timedelta(milliseconds=milliseconds)
    except OverflowError:
        return _EpochMilliseconds(milliseconds)


_DATE_CONVERTER = Converter(
    match_json_value=lambda o: _has_keys(o, "$date"),
    match_object=lambda o: isinstance(o, (datetime, _EpochMilliseconds)),
    to_json_value=_date_to_json,
    from_json_value=_date_from_json,
)


_VALID_FLAG_CHARS = set("gimuy")


def _sanitize_flags(raw: str) -> str:
    """Match the TS ``fromJSONValue`` flag-sanitization: cap 50 chars,
    filter to ``[gimuy]``, deduplicate."""

    if not isinstance(raw, str):
        raw = ""
    capped = raw[:50]
    filtered = [c for c in capped if c in _VALID_FLAG_CHARS]
    seen: set[str] = set()
    deduped = []
    for c in filtered:
        if c not in seen:
            seen.add(c)
            deduped.append(c)
    return "".join(deduped)


_REGEXP_CONVERTER = Converter(
    match_json_value=lambda o: _has_keys(o, "$regexp", "$flags"),
    match_object=lambda o: isinstance(o, EJSONRegExp),
    to_json_value=lambda r: {"$regexp": r.source, "$flags": r.flags},
    from_json_value=lambda o: EJSONRegExp(
        source=o["$regexp"], flags=_sanitize_flags(o["$flags"])
    ),
)


def _infnan_to_json(obj: float) -> dict[str, int]:
    if math.isnan(obj):
        sign = 0
    elif obj == math.inf:
        sign = 1
    else:
        sign = -1
    return {"$InfNaN": sign}


def _infnan_from_json(obj: dict[str, int]) -> float:
    sign = obj["$InfNaN"]
    if sign == 0:
        return float("nan")
    if sign == 1:
        return float("inf")
    return float("-inf")


_INFNAN_CONVERTER = Converter(
    match_json_value=lambda o: _has_keys(o, "$InfNaN"),
    match_object=_is_inf_or_nan,
    to_json_value=_infnan_to_json,
    from_json_value=_infnan_from_json,
)


_BINARY_CONVERTER = Converter(
    match_json_value=lambda o: _has_keys(o, "$binary"),
    match_object=_is_binary,
    to_json_value=lambda b: {"$binary": encode_base64(bytes(b))},
    from_json_value=lambda o: decode_base64(o["$binary"]),
)


# Forward-declared so ``_ESCAPE_CONVERTER.match_object`` can reference the
# list during recursion.
builtin_converters: list[Converter] = []


def _escape_match_object(obj: Any) -> bool:
    """True iff ``obj`` is a plain dict that looks like a tag form.

    Matches the TS ``matchObject`` for ``$escape``: 1-2 keys AND some
    converter's ``match_json_value`` returns True for it.
    """

    if not isinstance(obj, dict):
        return False
    key_count = len(obj)
    if key_count not in (1, 2):
        return False
    return any(c.match_json_value(obj) for c in builtin_converters)


def _escape_to_json(obj: dict[str, Any]) -> dict[str, Any]:
    # Import lazily — ``to_json_value`` lives in a sibling module that
    # depends on this one.
    from typeferry.ejson.to_from_json_value import to_json_value

    return {"$escape": {k: to_json_value(v) for k, v in obj.items()}}


def _escape_from_json(obj: dict[str, Any]) -> dict[str, Any]:
    from typeferry.ejson.to_from_json_value import from_json_value

    inner = obj["$escape"]
    return {k: from_json_value(v) for k, v in inner.items()}


_ESCAPE_CONVERTER = Converter(
    match_json_value=lambda o: _has_keys(o, "$escape"),
    match_object=_escape_match_object,
    to_json_value=_escape_to_json,
    from_json_value=_escape_from_json,
)


def _custom_to_json(obj: Any) -> dict[str, Any]:
    return {"$type": obj.type_name(), "$value": obj.to_json_value()}


def _custom_from_json(obj: dict[str, Any]) -> Any:
    type_name = obj["$type"]
    if not has_type(type_name):
        raise ValueError(f"Custom EJSON type {type_name} is not defined")
    return get_factory(type_name)(obj["$value"])


_CUSTOM_CONVERTER = Converter(
    match_json_value=lambda o: _has_keys(o, "$type", "$value"),
    match_object=is_custom_type,
    to_json_value=_custom_to_json,
    from_json_value=_custom_from_json,
)


# Order MUST match the TS ``builtinConverters`` array — Date, RegExp,
# Inf/NaN, Binary, Escape, Custom.
builtin_converters.extend(
    [
        _DATE_CONVERTER,
        _REGEXP_CONVERTER,
        _INFNAN_CONVERTER,
        _BINARY_CONVERTER,
        _ESCAPE_CONVERTER,
        _CUSTOM_CONVERTER,
    ]
)
