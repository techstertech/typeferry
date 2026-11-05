"""The shared JavaScript truthiness rule for authentication results."""

from __future__ import annotations

import math


def authentication_succeeded(value: object) -> bool:
    """Keep empty containers truthy while rejecting falsey JavaScript scalars."""

    if value is None or value is False:
        return False
    if isinstance(value, str):
        return value != ""
    if isinstance(value, (int, float)):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    return True
