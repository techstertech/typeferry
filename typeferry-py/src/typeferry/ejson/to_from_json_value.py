"""``to_json_value`` / ``from_json_value`` — port of TS EJSON recursion.

Mirrors:

* ``typeferry-ts/src/ejson/to-json-value.ts``
* ``typeferry-ts/src/ejson/from-json-value.ts``
* ``typeferry-ts/src/ejson/helpers/*``
* ``typeferry-ts/src/ejson/adjust-types-from-json-value.ts``

Implementation note: the TS port clones the value, then mutates it in
place via ``adjustTypesToJSONValue``. Python dicts/lists are mutable,
but a pure-functional recursion is simpler and avoids deepcopy
subtleties around custom types — we return freshly-built containers at
every level. Callers that rely on in-place adjustment MUST NOT pass
mutable structures and expect them to change.
"""

from __future__ import annotations

from typing import Any

from typeferry.ejson.converters import builtin_converters

MAX_EJSON_DEPTH = 128


def _try_to_json_value(item: Any, depth: int) -> Any:
    """Return the JSON form of ``item`` if a converter claims it, else ``_SENTINEL``."""

    for converter in builtin_converters:
        if converter.match_object(item):
            from typeferry.ejson.converters import _ESCAPE_CONVERTER, _escape_to_json

            if converter is _ESCAPE_CONVERTER and isinstance(item, dict):
                return _escape_to_json(item, depth)
            return converter.to_json_value(item)
    return _SENTINEL


def _try_from_json_value(item: Any, depth: int) -> Any:
    """Return the decoded form of ``item`` if it looks like a tag, else ``_SENTINEL``.

    Mirrors the TS ``fromJSONValueHelper`` gating: ``item`` must be an
    object (dict) with ≤2 keys and every key starting with ``$`` before
    any converter is consulted.
    """

    if not isinstance(item, dict):
        return _SENTINEL

    keys = list(item.keys())
    if len(keys) > 2 or not all(isinstance(k, str) and k.startswith("$") for k in keys):
        return _SENTINEL

    for converter in builtin_converters:
        if converter.match_json_value(item):
            from typeferry.ejson.converters import _ESCAPE_CONVERTER, _escape_from_json

            if converter is _ESCAPE_CONVERTER:
                return _escape_from_json(item, depth)
            return converter.from_json_value(item)
    return _SENTINEL


_SENTINEL: Any = object()


def to_json_value(item: Any, depth: int = 0) -> Any:
    """Convert a Python value into its JSON-compatible EJSON representation.

    Top-level converter match is tried first; otherwise recurse into
    containers.
    """

    if depth > MAX_EJSON_DEPTH:
        raise ValueError("EJSON nesting depth exceeds maximum")

    changed = _try_to_json_value(item, depth)
    if changed is not _SENTINEL:
        return changed

    if isinstance(item, dict):
        return {key: to_json_value(value, depth + 1) for key, value in item.items()}
    if isinstance(item, list):
        return [to_json_value(value, depth + 1) for value in item]
    if isinstance(item, tuple):
        # JSON has no tuple; mirror JS array behavior.
        return [to_json_value(value, depth + 1) for value in item]

    return item


def from_json_value(item: Any, depth: int = 0) -> Any:
    """Decode a JSON value produced by :func:`to_json_value` back to Python."""

    if depth > MAX_EJSON_DEPTH:
        raise ValueError("EJSON nesting depth exceeds maximum")

    changed = _try_from_json_value(item, depth)
    if changed is not _SENTINEL:
        return changed

    if isinstance(item, dict):
        return {key: from_json_value(value, depth + 1) for key, value in item.items()}
    if isinstance(item, list):
        return [from_json_value(value, depth + 1) for value in item]

    return item
