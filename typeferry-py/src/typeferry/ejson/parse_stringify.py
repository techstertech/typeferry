"""``parse`` / ``stringify`` — ports of the TS EJSON wrappers.

Mirrors ``typeferry-ts/src/ejson/parse.ts`` and
``typeferry-ts/src/ejson/stringify.ts``.
"""

from __future__ import annotations

import json
from typing import Any, NoReturn

from typeferry.ejson.stable_stringify import javascript_object_order, stable_stringify
from typeferry.ejson.to_from_json_value import MAX_EJSON_DEPTH, from_json_value, to_json_value


def _reject_json_constant(value: str) -> NoReturn:
    raise ValueError(f"Invalid JSON number constant: {value}")


def _check_depth(value: Any, max_depth: int = MAX_EJSON_DEPTH, depth: int = 0) -> None:
    if isinstance(value, (dict, list)):
        if depth >= max_depth:
            raise ValueError("EJSON nesting depth exceeds maximum")
        if isinstance(value, dict):
            for v in value.values():
                _check_depth(v, max_depth, depth + 1)
        else:
            for item in value:
                _check_depth(item, max_depth, depth + 1)


def parse(source: str) -> Any:
    """Parse an EJSON string into Python objects."""

    if not isinstance(source, str):
        raise TypeError("EJSON.parse argument should be a string")
    decoded = json.loads(source, parse_constant=_reject_json_constant)
    _check_depth(decoded)
    return from_json_value(decoded)


def stringify(
    value: Any,
    *,
    indent: bool | int | str | None = None,
    canonical: bool = False,
) -> str:
    """Serialize a Python value as an EJSON string.

    * ``canonical=True`` forces recursively sorted object keys.
    * ``indent=True`` is a shorthand for 2-space indentation (matching TS).
    * ``ensure_ascii=False`` — matches JS ``JSON.stringify`` Unicode
      behavior (raw non-ASCII instead of ``\\uXXXX`` escapes).
    """

    json_value = to_json_value(value)

    if indent is True:
        space: int | str | None = 2
    elif indent in (False, None):
        space = None
    else:
        space = indent

    if canonical:
        return stable_stringify(json_value, indent=space)

    separators = (",", ":") if space is None else None
    return json.dumps(
        javascript_object_order(json_value),
        indent=space,
        separators=separators,
        ensure_ascii=False,
        allow_nan=False,
    )
