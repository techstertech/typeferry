"""``parse`` / ``stringify`` — ports of the TS EJSON wrappers.

Mirrors ``typeferry-ts/src/ejson/parse.ts`` and
``typeferry-ts/src/ejson/stringify.ts``.
"""

from __future__ import annotations

import json
from typing import Any

from typeferry.ejson.stable_stringify import javascript_object_order, stable_stringify
from typeferry.ejson.to_from_json_value import from_json_value, to_json_value


def parse(source: str) -> Any:
    """Parse an EJSON string into Python objects."""

    if not isinstance(source, str):
        raise TypeError("EJSON.parse argument should be a string")
    return from_json_value(json.loads(source))


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
