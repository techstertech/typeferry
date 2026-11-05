"""Deep equality — port of ``typeferry-ts/src/ejson/equals.ts``.

Supports ``key_order_sensitive`` to mirror the TS option.
"""

from __future__ import annotations

import math
from datetime import datetime
from typing import Any

from typeferry.ejson.converters import _EpochMilliseconds
from typeferry.ejson.custom_types import is_custom_type
from typeferry.ejson.to_from_json_value import to_json_value


def _both_nan(a: Any, b: Any) -> bool:
    return (
        isinstance(a, float)
        and isinstance(b, float)
        and math.isnan(a)
        and math.isnan(b)
    )


def _binary_equal(a: bytes | bytearray, b: bytes | bytearray) -> bool:
    return bytes(a) == bytes(b)


def equals(a: Any, b: Any, *, key_order_sensitive: bool = False) -> bool:
    """Return True if ``a`` and ``b`` are EJSON-equivalent.

    Semantics match the TS port:

    * identity → True
    * NaN ≟ NaN → True (JS ``===`` disagrees; EJSON specializes this)
    * datetimes compared by millisecond instant
    * binaries compared element-wise
    * custom types compared via their JSON representations
    * arrays element-wise; length must match
    * objects key-by-key; order sensitivity is caller-selected
    """

    if a is b:
        return True
    if _both_nan(a, b):
        return True

    # Primitives / mismatched None.
    if a is None or b is None:
        return a is b
    if type(a) is bool or type(b) is bool:
        # bools are ints in Python; guard before numeric equality so
        # True != 1.0 matches JS's strictly-typed ``===``.
        if type(a) is not type(b):
            return False
        return bool(a == b)
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return bool(a == b)
    if isinstance(a, str) and isinstance(b, str):
        return bool(a == b)
    if isinstance(a, str) != isinstance(b, str):
        return False

    # Special reference types.
    if isinstance(a, _EpochMilliseconds) or isinstance(b, _EpochMilliseconds):
        return (
            isinstance(a, _EpochMilliseconds)
            and isinstance(b, _EpochMilliseconds)
            and a.milliseconds == b.milliseconds
        )
    if isinstance(a, datetime) and isinstance(b, datetime):
        return bool(a == b)
    if isinstance(a, datetime) or isinstance(b, datetime):
        return False

    if isinstance(a, (bytes, bytearray)) and isinstance(b, (bytes, bytearray)):
        return _binary_equal(a, b)
    if isinstance(a, (bytes, bytearray)) or isinstance(b, (bytes, bytearray)):
        return False

    # Arrays.
    a_is_list = isinstance(a, list)
    b_is_list = isinstance(b, list)
    if a_is_list != b_is_list:
        return False
    if a_is_list and b_is_list:
        if len(a) != len(b):
            return False
        return all(
            equals(x, y, key_order_sensitive=key_order_sensitive)
            for x, y in zip(a, b, strict=False)
        )

    # Custom types — degrade to structural comparison of their JSON form.
    custom_sum = int(is_custom_type(a)) + int(is_custom_type(b))
    if custom_sum == 1:
        return False
    if custom_sum == 2:
        return equals(
            to_json_value(a),
            to_json_value(b),
            key_order_sensitive=key_order_sensitive,
        )

    # Dict / dict.
    if isinstance(a, dict) and isinstance(b, dict):
        if len(a) != len(b):
            return False
        if key_order_sensitive:
            return all(
                ak == bk and equals(av, b[bk], key_order_sensitive=True)
                for (ak, av), bk in zip(a.items(), b.keys(), strict=False)
            )
        return all(
            key in b and equals(value, b[key], key_order_sensitive=False)
            for key, value in a.items()
        )

    return False
