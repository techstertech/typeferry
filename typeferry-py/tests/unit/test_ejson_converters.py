"""Built-in converter tag forms (PROTOCOL.md §3.1)."""

from __future__ import annotations

import math
from datetime import UTC, datetime

import pytest

from typeferry.ejson import (
    EJSON,
    EJSONRegExp,
    add_type,
    from_json_value,
    to_json_value,
)
from typeferry.ejson.custom_types import _clear_registry_for_tests


@pytest.fixture(autouse=True)
def _reset_custom_types() -> None:
    _clear_registry_for_tests()
    yield
    _clear_registry_for_tests()


# ---------------------------------------------------------------------------
# Date
# ---------------------------------------------------------------------------


def test_date_to_json_shape() -> None:
    dt = datetime(2024, 6, 1, 12, 30, 45, tzinfo=UTC)
    epoch_ms = int(dt.timestamp() * 1000)
    assert to_json_value(dt) == {"$date": epoch_ms}


def test_date_from_json_round_trip() -> None:
    dt = datetime(2024, 6, 1, 12, 30, 45, 123000, tzinfo=UTC)
    encoded = to_json_value(dt)
    decoded = from_json_value(encoded)
    assert isinstance(decoded, datetime)
    assert decoded.tzinfo is UTC
    assert int(decoded.timestamp() * 1000) == int(dt.timestamp() * 1000)


@pytest.mark.parametrize("millis", [-8_640_000_000_000_000, 8_640_000_000_000_000])
def test_wide_javascript_dates_round_trip_without_datetime_assumptions(millis: int) -> None:
    decoded = from_json_value({"$date": millis})

    assert to_json_value(decoded) == {"$date": millis}
    assert EJSON.stringify(decoded) == f'{{"$date":{millis}}}'


@pytest.mark.parametrize(
    "native", [datetime(1, 1, 1, tzinfo=UTC), datetime(9999, 12, 31, 23, 59, 59, 999000, tzinfo=UTC)]
)
def test_datetime_boundary_milliseconds_remain_exact(native: datetime) -> None:
    delta = native - datetime(1970, 1, 1, tzinfo=UTC)
    expected = (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000

    assert to_json_value(native) == {"$date": expected}
    assert from_json_value({"$date": expected}) == native


def test_naive_date_treated_as_utc() -> None:
    naive = datetime(2024, 6, 1, 12, 30, 45)
    encoded = to_json_value(naive)
    assert encoded == {"$date": int(naive.replace(tzinfo=UTC).timestamp() * 1000)}


# ---------------------------------------------------------------------------
# RegExp
# ---------------------------------------------------------------------------


def test_regexp_to_and_from_json() -> None:
    rx = EJSONRegExp(source="^foo.*$", flags="gi")
    encoded = to_json_value(rx)
    assert encoded == {"$regexp": "^foo.*$", "$flags": "gi"}
    assert from_json_value(encoded) == rx


def test_regexp_flag_sanitization_strips_unknown() -> None:
    encoded = {"$regexp": "a", "$flags": "gix"}
    decoded = from_json_value(encoded)
    assert isinstance(decoded, EJSONRegExp)
    assert decoded.flags == "gi"


def test_regexp_flag_sanitization_dedupes_and_caps() -> None:
    encoded = {"$regexp": "a", "$flags": "gggimm" + "x" * 100}
    decoded = from_json_value(encoded)
    assert isinstance(decoded, EJSONRegExp)
    assert set(decoded.flags) <= {"g", "i", "m", "u", "y"}
    assert len(decoded.flags) <= len({"g", "i", "m", "u", "y"})


# ---------------------------------------------------------------------------
# NaN / Inf
# ---------------------------------------------------------------------------


def test_nan_tag_form() -> None:
    assert to_json_value(float("nan")) == {"$InfNaN": 0}


def test_positive_infinity_tag_form() -> None:
    assert to_json_value(float("inf")) == {"$InfNaN": 1}


def test_negative_infinity_tag_form() -> None:
    assert to_json_value(float("-inf")) == {"$InfNaN": -1}


def test_infnan_round_trip() -> None:
    assert math.isnan(from_json_value({"$InfNaN": 0}))
    assert from_json_value({"$InfNaN": 1}) == float("inf")
    assert from_json_value({"$InfNaN": -1}) == float("-inf")


def test_regular_floats_pass_through() -> None:
    assert to_json_value(1.5) == 1.5
    assert to_json_value(0.0) == 0.0


# ---------------------------------------------------------------------------
# Binary
# ---------------------------------------------------------------------------


def test_binary_round_trip_bytes() -> None:
    data = b"hello \x00 world"
    encoded = to_json_value(data)
    assert encoded == {"$binary": "aGVsbG8gACB3b3JsZA=="}
    decoded = from_json_value(encoded)
    assert decoded == data


def test_binary_round_trip_bytearray() -> None:
    data = bytearray(b"\xde\xad\xbe\xef")
    encoded = to_json_value(data)
    decoded = from_json_value(encoded)
    assert decoded == bytes(data)


# ---------------------------------------------------------------------------
# Escape
# ---------------------------------------------------------------------------


def test_escape_wraps_decoy_date_shape() -> None:
    decoy = {"$date": 123}
    encoded = to_json_value(decoy)
    assert encoded == {"$escape": {"$date": 123}}


def test_escape_wraps_decoy_regexp_shape() -> None:
    decoy = {"$regexp": "x", "$flags": "i"}
    encoded = to_json_value(decoy)
    assert encoded == {"$escape": {"$regexp": "x", "$flags": "i"}}


def test_escape_decode_unwraps() -> None:
    encoded = {"$escape": {"$date": 123}}
    decoded = from_json_value(encoded)
    assert decoded == {"$date": 123}


def test_escape_round_trip() -> None:
    decoy = {"$InfNaN": 0}
    encoded = to_json_value(decoy)
    decoded = from_json_value(encoded)
    assert decoded == decoy


def test_plain_object_not_escaped() -> None:
    value = {"a": 1, "b": 2}
    encoded = to_json_value(value)
    assert encoded == value


# ---------------------------------------------------------------------------
# Custom types
# ---------------------------------------------------------------------------


class Address:
    def __init__(self, street: str, city: str) -> None:
        self.street = street
        self.city = city

    def type_name(self) -> str:
        return "address"

    def to_json_value(self) -> dict[str, str]:
        return {"street": self.street, "city": self.city}

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Address)
            and self.street == other.street
            and self.city == other.city
        )


def _make_address(payload: dict[str, str]) -> Address:
    return Address(payload["street"], payload["city"])


def test_custom_type_round_trip() -> None:
    add_type("address", _make_address)
    value = Address("1 Main", "Springfield")
    encoded = to_json_value(value)
    assert encoded == {
        "$type": "address",
        "$value": {"street": "1 Main", "city": "Springfield"},
    }
    decoded = from_json_value(encoded)
    assert decoded == value


def test_custom_type_unknown_raises() -> None:
    with pytest.raises(ValueError, match="not defined"):
        from_json_value({"$type": "unknown", "$value": {}})


def test_add_type_duplicate_raises() -> None:
    add_type("address", _make_address)
    with pytest.raises(ValueError, match="already present"):
        add_type("address", _make_address)


# ---------------------------------------------------------------------------
# Nested recursion
# ---------------------------------------------------------------------------


def test_nested_date_in_list() -> None:
    dt = datetime(2024, 6, 1, tzinfo=UTC)
    value = {"events": [dt, dt]}
    encoded = to_json_value(value)
    assert encoded == {"events": [{"$date": int(dt.timestamp() * 1000)}] * 2}
    decoded = from_json_value(encoded)
    assert decoded == value


def test_deeply_nested_binary() -> None:
    value = {"a": {"b": {"c": b"payload"}}}
    round_tripped = from_json_value(to_json_value(value))
    assert round_tripped == value


def test_ejson_namespace_round_trip() -> None:
    text = EJSON.stringify({"when": datetime(2024, 1, 1, tzinfo=UTC)})
    decoded = EJSON.parse(text)
    assert decoded["when"] == datetime(2024, 1, 1, tzinfo=UTC)
